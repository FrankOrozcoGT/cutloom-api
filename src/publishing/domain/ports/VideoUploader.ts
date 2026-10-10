import type { Readable } from 'node:stream'
import type { YouTubeMetadata } from '../entities/ContentRevision'
import type { PublishedVideoStatus } from '../entities/PublishedVideo'

export interface UploadVideoInput {
  accessToken: string
  /** Stream del binario del video — nunca se bufferiza completo en memoria (ver cada adaptador). */
  videoStream: Readable
  videoSize: number
  /** Metadata compartida (misma ContentRevision que YouTube) — cada adaptador la traduce a su propio shape (ver adaptMetadataForTikTok). */
  metadata: YouTubeMetadata
  /** Si se especifica y el adaptador soporta scheduling nativo (YouTube), el video se sube como "private" y la plataforma lo hace público automáticamente en este instante. Los adaptadores sin scheduling nativo (TikTok) nunca reciben publishAt acá — ver BulkUploadOrchestrator: el caso de uso difiere el upload real al cron de PublishScheduledVideosUseCase. */
  publishAt: Date | null
  /** Opciones específicas de la plataforma (ej. TikTok privacyLevel/postMode) — opaco para el caso de uso, cada adaptador interpreta su propio shape. */
  platformOptions: Record<string, unknown> | null
}

export interface UploadVideoResult {
  /** Id del video ya publicado en la plataforma — null si el resultado quedó en un estado intermedio (ej. TikTok Inbox/Uploading sin confirmación aún). */
  platformVideoId: string | null
  status: PublishedVideoStatus
  /** Solo TikTok: id devuelto por video/init, usado para resolver el resultado final por webhook — null en cualquier adaptador sin ese concepto. */
  publishId: string | null
  /** true si el adaptador descubrió, en el momento real del intento de subida, que el upload va a requerir una acción manual del usuario para completarse (ej. TikTok: la app no está auditada, así que cayó a MEDIA_UPLOAD y el video quedó como borrador en la bandeja del usuario — ver TikTokContentPostingUploader). El caller lo usa para avisarle de inmediato, sin esperar ninguna confirmación asíncrona (ver BulkUploadVideoUseCase/PublishScheduledVideosUseCase). false para cualquier resultado que ya quedó resuelto (éxito u otro). */
  pendingManualAction: boolean
}

export class VideoUploadTokenExpiredError extends Error {
  constructor() {
    super('Platform access token expired')
    this.name = 'VideoUploadTokenExpiredError'
  }
}

export class VideoUploadQuotaExceededError extends Error {
  constructor() {
    super('Platform API quota or rate limit exceeded')
    this.name = 'VideoUploadQuotaExceededError'
  }
}

/** La plataforma rechazó las opciones pedidas (ej. TikTok: privacy_level fuera de las opciones permitidas para una app no auditada) — no reintentar, el caller debe caer a un fallback (ver GetTikTokPublishingCapabilitiesUseCase). */
export class VideoUploadRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VideoUploadRejectedError'
  }
}

/**
 * Puerto único de subida — YouTubeDataApiUploader y TikTokContentPostingUploader son los
 * únicos dos puntos del sistema que conocen el nombre de su plataforma. BulkUploadOrchestrator
 * y todo lo demás (repositorio, calendarización, controller) son 100% genéricos sobre esta
 * interfaz.
 */
export interface VideoUploader {
  upload(input: UploadVideoInput): Promise<UploadVideoResult>
}
