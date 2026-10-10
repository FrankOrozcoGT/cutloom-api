import { PublishedVideoType, VideoPlatform, blocksNewAttempt, isUploaded } from '../../domain/entities/PublishedVideo'
import { SourceUploadStatus } from '../../domain/entities/SourceUpload'
import type { BulkUploadRepository } from '../../domain/ports/BulkUploadRepository'
import type { SourceUploadRepository } from '../../domain/ports/SourceUploadRepository'
import type { CreateAwaitingUploadInput, PublishedVideoRepository } from '../../domain/ports/PublishedVideoRepository'
import type { ContentRevisionRepository } from '../../domain/ports/ContentRevisionRepository'
import type { ActivePlatformAccountRepository } from '../../domain/ports/ActivePlatformAccountRepository'
import { NoPlatformConnectionError } from '../../domain/ports/PlatformCredentialResolver'
import type { TusUploadCreator } from '../../domain/ports/TusUploadCreator'

export class MetadataRevisionNotFoundError extends Error {
  constructor(revisionId: string) {
    super(`Content revision not found: ${revisionId}`)
    this.name = 'MetadataRevisionNotFoundError'
  }
}

/** El metadataRevisionId de un item debe pertenecer al mismo sourceId — evita subir un video con el título/descripción/tags de un video distinto. */
export class MetadataRevisionSourceMismatchError extends Error {
  constructor(sourceId: string, metadataRevisionId: string) {
    super(`Content revision ${metadataRevisionId} does not belong to sourceId ${sourceId}`)
    this.name = 'MetadataRevisionSourceMismatchError'
  }
}

export class TooManyVideosError extends Error {
  constructor(max: number) {
    super(`Cannot upload more than ${max} videos in a single bulk`)
    this.name = 'TooManyVideosError'
  }
}

// Video largo + hasta 9 shorts derivados — mismo techo que el bulk-upload anterior.
export const MAX_VIDEOS_PER_BULK = 10

export interface PlanBulkUploadItem {
  sourceId: string
  videoType: PublishedVideoType
  /** Prioridad relativa (0-1) que decide el orden de calendarización dentro de la serie — el caller traduce cualquier señal externa (ej. score de shorts-intelligence) a este valor. Ignorado para el largo. */
  priority: number | null
  /** Solo shorts: segundo exacto donde arranca dentro del largo — ver appendLongVideoLink. null si no aplica. */
  longVideoTimestampSec: number | null
  /** Solo shorts, opcional: URL del largo ya publicado cuando no viene en este mismo bulk. */
  longVideoUrl: string | null
  metadataRevisionId: string
  videoSizeBytes: number
  /** Por plataforma: null si este item no se publica en esa plataforma (ej. video largo cuando TikTok no lo recibe nunca). */
  platformOptionsByPlatform: Partial<Record<VideoPlatform, Record<string, unknown> | null>>
}

export interface PlanBulkUploadInput {
  organizationId: string
  seriesId: string
  timeZone: string
  longVideoPublishDay: Date
  platforms: VideoPlatform[]
  items: PlanBulkUploadItem[]
}

export interface PlanBulkUploadUploadUrl {
  sourceId: string
  /** null si este archivo ya terminó de subir en un intento anterior (resumir un bulk existente) — no hay nada que subir, el frontend debe saltearlo. */
  uploadUrl: string | null
  /**
   * Plataformas de este sourceId que YA están Uploaded de verdad (de cualquier bulk, no solo
   * este) — no se incluyeron en el plan nuevo, nunca se les reintentó la publicación. Scheduled/
   * Publishing/Inbox NO entran acá (todavía no son "ya subido"), aunque igual bloquean crear una
   * fila nueva (ver blocksNewAttempt). El backend nunca decide "republicar a la fuerza": si el
   * frontend quiere forzar un reintento para alguna de estas plataformas, es una operación
   * explícita aparte (pendiente de definir), no algo que planBulkUpload haga solo porque el
   * sourceId volvió a aparecer en un plan.
   */
  uploadedPlatforms: VideoPlatform[]
}

export interface PlanBulkUploadOutput {
  bulkUploadId: string
  uploads: PlanBulkUploadUploadUrl[]
}

// TikTok nunca recibe el video largo de una serie, solo sus shorts derivados (ver
// docs/tiktok-publishing-viability.md) — la Content Posting API está pensada para contenido
// corto. Único lugar de esta regla: el resto del flujo es genérico por plataforma.
function excludesLongVideos(platform: VideoPlatform): boolean {
  return platform === VideoPlatform.TikTok
}

/**
 * Declara un bulk completo (video largo + shorts, hacia una o varias plataformas a la vez) SIN
 * subir ningún byte todavía — crea el BulkUpload, valida la metadata, resuelve la cuenta activa
 * de cada plataforma destino, y por cada sourceId genera UN SOLO upload tus (el binario se sube
 * una vez, compartido entre todas las plataformas a las que ese item se publique). La
 * calendarización NO se calcula acá: recién cuando todos los archivos terminen de subir (ver
 * BulkUploadOrchestrator.onSourceUploadCompleted) — un archivo puede tardar horas o días.
 */
export class PlanBulkUploadUseCase {
  constructor(
    private readonly bulkUploadRepository: BulkUploadRepository,
    private readonly sourceUploadRepository: SourceUploadRepository,
    private readonly publishedVideoRepository: PublishedVideoRepository,
    private readonly contentRevisionRepository: ContentRevisionRepository,
    private readonly activePlatformAccountRepository: ActivePlatformAccountRepository,
    private readonly tusUploadCreator: TusUploadCreator,
  ) {}

  async execute(input: PlanBulkUploadInput): Promise<PlanBulkUploadOutput> {
    if (input.items.length > MAX_VIDEOS_PER_BULK) {
      throw new TooManyVideosError(MAX_VIDEOS_PER_BULK)
    }

    const revisionIds = [...new Set(input.items.map((item) => item.metadataRevisionId))]
    const revisions = await this.contentRevisionRepository.findByIds(input.organizationId, revisionIds)
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]))
    for (const item of input.items) {
      const revision = revisionById.get(item.metadataRevisionId)
      if (!revision) throw new MetadataRevisionNotFoundError(item.metadataRevisionId)
      if (revision.sourceId !== item.sourceId) {
        throw new MetadataRevisionSourceMismatchError(item.sourceId, item.metadataRevisionId)
      }
    }

    const platformAccountIdByPlatform = new Map<VideoPlatform, string>()
    for (const platform of input.platforms) {
      const accountId = await this.activePlatformAccountRepository.findActivePlatformAccountId(input.organizationId, platform)
      if (!accountId) throw new NoPlatformConnectionError(platform)
      platformAccountIdByPlatform.set(platform, accountId)
    }

    // Resumir: si ya hay un bulk activo para este seriesId (ej. el usuario cerró la pestaña a
    // mitad de subir, o algunos archivos fallaron y el frontend reintenta el mismo plan), se
    // reutiliza en vez de intentar crear uno nuevo — el unique index parcial lo impediría de
    // todas formas, pero la intención real del caller acá es "seguir donde quedó", no un error.
    const bulkUpload =
      (await this.bulkUploadRepository.findActiveBySeriesId(input.seriesId)) ??
      (await this.bulkUploadRepository.create(input.organizationId, input.seriesId, input.timeZone, input.longVideoPublishDay))

    const uploads: PlanBulkUploadUploadUrl[] = []
    const awaitingUploadInputs: CreateAwaitingUploadInput[] = []

    for (const item of input.items) {
      // Busca por sourceId sin filtrar status y SIN importar de qué bulk venga — detecta tanto
      // filas del bulk actual (resumir) como de cualquier bulk anterior (ej. los legacy
      // migrados antes de que existiera el concepto de bulk).
      const allVideosForSourceId = await this.publishedVideoRepository.findBySourceId(item.sourceId)

      // Para el frontend: SOLO Uploaded cuenta como "ya subido" de verdad — Scheduled/Publishing/
      // Inbox son trabajo en curso, no publicación confirmada (ver isUploaded).
      const uploadedPlatforms = new Set(
        allVideosForSourceId.filter((video) => isUploaded(video.status)).map((video) => video.platform),
      )

      // Para decidir si hay que crear una fila nueva: más amplio que publishedPlatforms —
      // Scheduled/Publishing/Inbox también bloquean (ya hay un intento real en curso, no hay que
      // duplicarlo), aunque todavía no sean "publicado". Solo AwaitingUpload/Failed quedan libres.
      const blockedPlatforms = new Set(
        allVideosForSourceId.filter((video) => blocksNewAttempt(video.status)).map((video) => video.platform),
      )

      const existingSourceUpload = await this.sourceUploadRepository.findByBulkUploadIdAndSourceId(bulkUpload.id, item.sourceId)
      // Plataformas que ya tienen una fila AwaitingUpload en ESTE sourceUpload — ya existe el
      // registro en BD (de un intento anterior de este mismo bulk), no hay que recrearlo.
      const alreadyCreatedPlatforms = existingSourceUpload
        ? new Set((await this.publishedVideoRepository.findBySourceUploadId(existingSourceUpload.id)).map((video) => video.platform))
        : new Set<VideoPlatform>()

      // Plataformas de ESTE plan que todavía necesitan el binario — excluye las bloqueadas
      // (blockedPlatforms), las que ya tienen fila creada en este sourceUpload
      // (alreadyCreatedPlatforms) y las que esta plataforma nunca recibe (ej. largo en TikTok).
      // Si no queda ninguna, no tiene sentido ofrecer uploadUrl: el archivo no serviría para
      // nada en este plan, aunque el SourceUpload en sí nunca se haya subido.
      const pendingPlatforms = input.platforms.filter(
        (platform) =>
          !(item.videoType === PublishedVideoType.Long && excludesLongVideos(platform)) &&
          !blockedPlatforms.has(platform) &&
          !alreadyCreatedPlatforms.has(platform),
      )
      const stillNeedsUpload = pendingPlatforms.length > 0 || alreadyCreatedPlatforms.size > 0

      const sourceUpload = stillNeedsUpload
        ? (existingSourceUpload ?? (await this.createSourceUpload(input.organizationId, bulkUpload.id, item)))
        : null

      const uploadUrl =
        !sourceUpload || existingSourceUpload?.status === SourceUploadStatus.Completed
          ? null
          : this.tusUploadCreator.resolveUploadUrl(sourceUpload.tusUploadId)

      uploads.push({ sourceId: item.sourceId, uploadUrl, uploadedPlatforms: [...uploadedPlatforms] })

      if (!sourceUpload) continue

      for (const platform of pendingPlatforms) {
        awaitingUploadInputs.push({
          organizationId: input.organizationId,
          platform,
          platformAccountId: platformAccountIdByPlatform.get(platform)!,
          sourceUploadId: sourceUpload.id,
          seriesId: input.seriesId,
          sourceId: item.sourceId,
          videoType: item.videoType,
          priority: item.priority,
          longVideoTimestampSec: item.longVideoTimestampSec,
          longVideoUrl: item.longVideoUrl,
          metadataRevisionId: item.metadataRevisionId,
          platformOptions: item.platformOptionsByPlatform[platform] ?? null,
        })
      }
    }

    await this.publishedVideoRepository.createManyAwaitingUpload(awaitingUploadInputs)

    return { bulkUploadId: bulkUpload.id, uploads }
  }

  private async createSourceUpload(organizationId: string, bulkUploadId: string, item: PlanBulkUploadItem) {
    const tusUpload = await this.tusUploadCreator.createUpload({
      sizeBytes: item.videoSizeBytes,
      metadata: { organizationId, bulkUploadId, sourceId: item.sourceId },
    })
    return this.sourceUploadRepository.create({
      bulkUploadId,
      sourceId: item.sourceId,
      tusUploadId: tusUpload.id,
      videoSizeBytes: item.videoSizeBytes,
    })
  }
}
