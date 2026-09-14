import type { Readable } from 'node:stream'
import type { YouTubeMetadata } from '../../domain/entities/ContentRevision'
import { YouTubeVideoStatus, type YouTubeVideoType } from '../../domain/entities/YouTubeVideo'
import type { ContentRevisionRepository } from '../../domain/ports/ContentRevisionRepository'
import type { TokenEncryptionService } from '../../domain/ports/TokenEncryptionService'
import type { YouTubeOAuthTokenRepository } from '../../domain/ports/YouTubeOAuthTokenRepository'
import type { YouTubeVideoRepository } from '../../domain/ports/YouTubeVideoRepository'
import {
  YouTubeUploadQuotaExceededError,
  YouTubeUploadTokenExpiredError,
  type YouTubeUploader,
} from '../../domain/ports/YouTubeUploader'
import type { YouTubeOAuthPort } from '../../domain/ports/YouTubeOAuthPort'
import { ScheduleUploadPlanService, type ScheduleSlotItem } from '../services/ScheduleUploadPlanService'

// YouTube Data API v3 factura uploads en un bucket propio con límite por defecto de 100
// llamadas/día por proyecto de Google Cloud (desde el cambio de cuotas de junio 2026) — 10
// por bulk (video largo + hasta 9 shorts derivados, el caso de uso real de este backend)
// deja margen para varios bulks en el mismo día sin arriesgar la memoria del proceso.
export const MAX_VIDEOS_PER_BULK = 10

// YouTube Data API documenta un techo de 256GB por archivo (videos.insert), sin límite de
// tamaño propio para Shorts — Shorts y videos largos comparten ese mismo techo de plataforma;
// lo que distingue a un Short es la duración (máx. 3 min), no el tamaño permitido. El video
// viaja en streaming directo sin bufferizarse en memoria (ver YouTubeDataApiUploader), así
// que técnicamente podríamos aceptar hasta esos 256GB — pero un Short bien codificado de 3
// min pesa 30-80MB en la práctica, así que aceptar el mismo techo que un video largo sería
// dejar pasar archivos absurdamente grandes para ese tipo de contenido, gastando ancho de
// banda y tiempo del servidor sin ninguna razón real. Por eso el límite aplicado es una
// decisión de producto por tipo de contenido, no la restricción técnica de YouTube.
export const MAX_VIDEO_FILE_SIZE_BYTES_BY_TYPE = {
  long: 20 * 1024 * 1024 * 1024, // hasta 20GB: cubre streams largos en buena calidad.
  short: 500 * 1024 * 1024, // hasta 500MB: muy por encima de los 30-80MB típicos de un Short de 3 min, con margen.
} as const

// Único lugar de verdad para el techo del request HTTP completo: se deriva de los límites por
// tipo (en vez de un número independiente) para que nunca queden matemáticamente
// incoherentes entre sí — en el peor caso, 1 video largo + (MAX_VIDEOS_PER_BULK - 1) shorts,
// más margen para el campo "payload" y overhead del multipart.
export const BULK_UPLOAD_BODY_LIMIT_BYTES =
  MAX_VIDEO_FILE_SIZE_BYTES_BY_TYPE.long +
  (MAX_VIDEOS_PER_BULK - 1) * MAX_VIDEO_FILE_SIZE_BYTES_BY_TYPE.short +
  10 * 1024 * 1024

export class NoYouTubeConnectionError extends Error {
  constructor() {
    super('Organization has no connected YouTube account')
    this.name = 'NoYouTubeConnectionError'
  }
}

export class TooManyVideosError extends Error {
  constructor() {
    super(`Cannot upload more than ${MAX_VIDEOS_PER_BULK} videos in a single bulk request`)
    this.name = 'TooManyVideosError'
  }
}

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

/** Nunca debería ocurrir en producción: prepare() ya crea un registro pendiente por cada item del plan (createManyPending garantiza cardinalidad) — señal de un bug interno si aparece, no de un dato de usuario inválido. */
export class PendingUploadNotFoundError extends Error {
  constructor(sourceId: string) {
    super(`No pending youtube_videos record was created for sourceId: ${sourceId}`)
    this.name = 'PendingUploadNotFoundError'
  }
}

/**
 * Distinto de MetadataRevisionNotFoundError: ese error significa "el usuario mandó un
 * metadataRevisionId que no existe" (validación real de prepare()). Este significa "prepare()
 * ya validó y resolvió la metadata para este mismo item, pero uploadItem() no la encuentra en
 * su propio mapa interno" — invariante interna rota (bug), nunca un dato de usuario inválido.
 * Se distingue para que el controller la mapee a 500 (alerta real), no a 400.
 */
export class MetadataNotResolvedForUploadError extends Error {
  constructor(metadataRevisionId: string) {
    super(`Internal inconsistency: metadata for revision ${metadataRevisionId} was not resolved during prepare()`)
    this.name = 'MetadataNotResolvedForUploadError'
  }
}

export interface BulkUploadPlanItem {
  seriesId: string
  sourceId: string
  videoType: YouTubeVideoType
  metadataRevisionId: string
  /** Prioridad relativa (0-1) que decide el orden de calendarización dentro de la serie — concepto propio de publishing, el caller traduce cualquier señal externa (ej. score de shorts-intelligence) a este valor. Ignorado para el largo. */
  priority: number | null
}

export interface BulkUploadItemResult {
  sourceId: string
  status: YouTubeVideoStatus
  youtubeVideoId: string | null
  url: string | null
  error: string | null
}

export interface PrepareBulkUploadInput {
  organizationId: string
  timeZone: string
  longVideoPublishDay: Date
  items: BulkUploadPlanItem[]
}

/**
 * @fastify/multipart entrega un Readable de archivo a la vez: hay que subirlo a YouTube en
 * cuanto llega, no acumular items en un array. Por eso este caso de uso se invoca en dos
 * fases: prepare() valida todo el plan de antemano (metadata, token, cuota, calendarización)
 * y deja un registro Uploading por item sin tocar streams; uploadItem() se llama una vez por
 * archivo, desde dentro del loop del multipart en PublishingController, mientras ese stream
 * sigue vivo.
 */
export class BulkUploadToYouTubeUseCase {
  constructor(
    private readonly tokenRepository: YouTubeOAuthTokenRepository,
    private readonly encryptionService: TokenEncryptionService,
    private readonly oauthProvider: YouTubeOAuthPort,
    private readonly contentRevisionRepository: ContentRevisionRepository,
    private readonly youTubeUploader: YouTubeUploader,
    private readonly youTubeVideoRepository: YouTubeVideoRepository,
    private readonly scheduleUploadPlanService: ScheduleUploadPlanService,
  ) {}

  async prepare(input: PrepareBulkUploadInput): Promise<BulkUploadSession> {
    if (input.items.length > MAX_VIDEOS_PER_BULK) {
      throw new TooManyVideosError()
    }

    const token = await this.tokenRepository.findByOrganizationId(input.organizationId)
    if (!token) {
      throw new NoYouTubeConnectionError()
    }

    // Metadata se valida completa antes de empezar cualquier upload — si un revisionId no
    // existe, todo el bulk falla antes de gastar cuota subiendo los demás videos. Un solo
    // findByIds en vez de un findById por item (N+1).
    const revisionIds = [...new Set(input.items.map((item) => item.metadataRevisionId))]
    const revisions = await this.contentRevisionRepository.findByIds(input.organizationId, revisionIds)
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]))
    const metadataByRevisionId = new Map(revisions.map((revision) => [revision.id, revision.metadata]))

    // No alcanza con validar que el revisionId exista — también debe pertenecer al mismo
    // sourceId del item, o un metadataRevisionId equivocado (bug de frontend, payload
    // manipulado) subiría un video con el título/descripción/tags de un video distinto sin
    // ningún error visible.
    for (const item of input.items) {
      const revision = revisionById.get(item.metadataRevisionId)
      if (!revision) {
        throw new MetadataRevisionNotFoundError(item.metadataRevisionId)
      }
      if (revision.sourceId !== item.sourceId) {
        throw new MetadataRevisionSourceMismatchError(item.sourceId, item.metadataRevisionId)
      }
    }

    const refreshToken = token.encryptedRefreshToken ? this.encryptionService.decrypt(token.encryptedRefreshToken) : null
    let accessToken = this.encryptionService.decrypt(token.encryptedAccessToken)

    // Refresh una sola vez al inicio si ya está vencido — reutilizado por todos los items
    // del bulk en vez de refrescar por cada upload individual. Se persiste de inmediato para
    // que el próximo bulk-upload de esta organización reuse este mismo token en vez de
    // volver a refrescarlo innecesariamente contra Google.
    if (token.isExpired() && refreshToken) {
      const refreshed = await this.oauthProvider.refreshAccessToken(refreshToken)
      accessToken = refreshed.accessToken
      await this.tokenRepository.upsert({
        organizationId: input.organizationId,
        encryptedAccessToken: this.encryptionService.encrypt(accessToken),
        encryptedRefreshToken: token.encryptedRefreshToken,
        expiresAt: refreshed.expiresAt,
      })
    }

    // Calendarización + creación de pendientes serializadas con un lock por organización: sin
    // esto, dos bulk-uploads concurrentes de la misma organización leerían el mismo estado de
    // slots ocupados y ambos calcularían un calendario válido de forma independiente,
    // violando el techo semanal real (ver ScheduleUploadPlanService.WEEKLY_SLOT_CAP).
    const { publishAtBySourceId, pendingIdBySourceId } = await this.youTubeVideoRepository.withOrganizationLock(
      input.organizationId,
      async () => {
        const occupyingSlots = await this.youTubeVideoRepository.findOccupyingSlotsByOrganizationId(
          input.organizationId,
          new Date(),
        )
        const scheduleItems: ScheduleSlotItem[] = input.items.map((item) => ({
          sourceId: item.sourceId,
          videoType: item.videoType,
          priority: item.priority,
        }))
        const suggestedSlots = this.scheduleUploadPlanService.plan(
          {
            organizationId: input.organizationId,
            timeZone: input.timeZone,
            longVideoPublishDay: input.longVideoPublishDay,
            items: scheduleItems,
          },
          occupyingSlots,
        )
        const publishAtBySourceId = new Map(suggestedSlots.map((slot) => [slot.sourceId, slot.publishAt]))

        // Se crean los registros Uploading ANTES de subir a YouTube (un solo INSERT
        // multi-fila en vez de uno por item) — si el upload a YouTube tiene éxito pero la
        // confirmación posterior (markUploaded) falla, el video nunca queda huérfano:
        // siempre hay una fila local que lo referencia, aunque quede atascada en Uploading
        // hasta reconciliarse.
        const pending = await this.youTubeVideoRepository.createManyPending(
          input.items.map((item) => ({
            organizationId: input.organizationId,
            seriesId: item.seriesId,
            sourceId: item.sourceId,
            videoType: item.videoType,
            metadataRevisionId: item.metadataRevisionId,
            publishAt: publishAtBySourceId.get(item.sourceId) ?? null,
          })),
        )
        const pendingIdBySourceId = new Map(pending.map((video) => [video.sourceId, video.id]))

        return { publishAtBySourceId, pendingIdBySourceId }
      },
    )

    return new BulkUploadSession(
      input.organizationId,
      metadataByRevisionId,
      pendingIdBySourceId,
      publishAtBySourceId,
      accessToken,
      refreshToken,
      this.oauthProvider,
      this.youTubeUploader,
      this.youTubeVideoRepository,
      this.tokenRepository,
      this.encryptionService,
    )
  }
}

export class BulkUploadSession {
  private refreshedAfterExpiry = false

  constructor(
    private readonly organizationId: string,
    private readonly metadataByRevisionId: Map<string, YouTubeMetadata>,
    private readonly pendingIdBySourceId: Map<string, string>,
    private readonly publishAtBySourceId: Map<string, Date>,
    private accessToken: string,
    private readonly refreshToken: string | null,
    private readonly oauthProvider: YouTubeOAuthPort,
    private readonly youTubeUploader: YouTubeUploader,
    private readonly youTubeVideoRepository: YouTubeVideoRepository,
    private readonly tokenRepository: YouTubeOAuthTokenRepository,
    private readonly encryptionService: TokenEncryptionService,
  ) {}

  /**
   * Sube un item mientras su videoStream sigue vivo — llamado una vez por archivo del
   * multipart. markUploaded/markFailed se llaman aquí mismo, por item, en vez de acumularse
   * para un solo UPDATE batch al final del loop: si el proceso crashea a mitad de un bulk
   * grande, los items ya subidos a YouTube deben quedar confirmados de inmediato (nunca en
   * Uploading sin motivo) — batchear reintroduciría el riesgo de huérfanos que este patrón
   * de estado explícito existe para evitar.
   */
  async uploadItem(item: BulkUploadPlanItem, videoStream: Readable): Promise<BulkUploadItemResult> {
    // Bug interno si ocurre (prepare() ya validó y resolvió ambos para este mismo item) — no
    // un dato de usuario inválido, por eso usan errores distintos de los de prepare().
    const metadata = this.metadataByRevisionId.get(item.metadataRevisionId)
    if (!metadata) {
      throw new MetadataNotResolvedForUploadError(item.metadataRevisionId)
    }
    const pendingId = this.pendingIdBySourceId.get(item.sourceId)
    if (!pendingId) {
      throw new PendingUploadNotFoundError(item.sourceId)
    }

    const publishAt = this.publishAtBySourceId.get(item.sourceId) ?? null
    let uploadResult: { youtubeVideoId: string }
    try {
      uploadResult = await this.youTubeUploader.upload({ accessToken: this.accessToken, videoStream, metadata, publishAt })
    } catch (error) {
      if (error instanceof YouTubeUploadTokenExpiredError && !this.refreshedAfterExpiry && this.refreshToken) {
        // El token expiró a mitad del bulk (no en el chequeo inicial) — se refresca una sola
        // vez más; los siguientes items reusan el token nuevo. No se reintenta este item: su
        // stream ya se consumió parcialmente y no se puede re-leer desde el inicio. Se
        // persiste de inmediato (igual que el refresh preventivo de prepare()) para que el
        // próximo bulk-upload reuse este token en vez de volver a refrescar innecesariamente.
        this.refreshedAfterExpiry = true
        const refreshed = await this.oauthProvider.refreshAccessToken(this.refreshToken)
        this.accessToken = refreshed.accessToken
        await this.tokenRepository.upsert({
          organizationId: this.organizationId,
          encryptedAccessToken: this.encryptionService.encrypt(refreshed.accessToken),
          encryptedRefreshToken: this.encryptionService.encrypt(this.refreshToken),
          expiresAt: refreshed.expiresAt,
        })
      }
      // El upload a YouTube nunca se confirmó — es seguro marcar el registro local como fallido.
      await this.youTubeVideoRepository.markFailed(this.organizationId, pendingId)
      return this.failedResult(item.sourceId, error)
    }

    const status = publishAt ? YouTubeVideoStatus.Scheduled : YouTubeVideoStatus.Uploaded

    // El upload a YouTube YA tuvo éxito en este punto (video existe en el canal, irreversible
    // sin una llamada DELETE aparte) — si markUploaded fallara acá, NO se marca Failed (eso
    // perdería el youtubeVideoId real): el registro queda en Uploading, reconciliable después,
    // en vez de reportarse como fallido cuando en realidad el video sí está en YouTube.
    await this.youTubeVideoRepository.markUploaded(this.organizationId, pendingId, uploadResult.youtubeVideoId, status)

    return {
      sourceId: item.sourceId,
      status,
      youtubeVideoId: uploadResult.youtubeVideoId,
      url: `https://www.youtube.com/watch?v=${uploadResult.youtubeVideoId}`,
      error: null,
    }
  }

  private failedResult(sourceId: string, error: unknown): BulkUploadItemResult {
    const message =
      error instanceof YouTubeUploadQuotaExceededError
        ? 'QuotaExceeded'
        : error instanceof YouTubeUploadTokenExpiredError
          ? 'TokenExpired'
          : error instanceof Error
            ? error.message
            : 'UnknownError'

    return { sourceId, status: YouTubeVideoStatus.Failed, youtubeVideoId: null, url: null, error: message }
  }
}
