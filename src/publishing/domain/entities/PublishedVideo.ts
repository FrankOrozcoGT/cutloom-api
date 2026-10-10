/** Plataforma de destino — el único punto donde el dominio distingue YouTube de TikTok es el adaptador VideoUploader inyectado; todo lo demás (entidad, repositorio, caso de uso, calendarización) es el mismo código para cualquier plataforma. */
export const VideoPlatform = {
  YouTube: 'youtube',
  TikTok: 'tiktok',
} as const
export type VideoPlatform = (typeof VideoPlatform)[keyof typeof VideoPlatform]

export const PublishedVideoStatus = {
  /** Registro creado cuando se declaró el plan del bulk, antes de que el binario (SourceUpload)
   * termine de subir y antes de calcular publishAt — la calendarización real recién se calcula
   * cuando TODOS los sourceId del bulk terminaron de subir (ver BulkUploadOrchestrator), así que
   * este estado puede durar tanto como tarde la subida completa del bulk, no solo este item. */
  AwaitingUpload: 'awaiting_upload',
  /** El binario (SourceUpload) ya está completo en R2 y publishAt ya se calculó — el intento
   * real de publicación en la plataforma está en curso o a punto de empezar. Reemplaza al viejo
   * "uploading" (que mezclaba "subiendo el binario" con "publicando en la plataforma" — ahora
   * son etapas separadas: ver SourceUploadStatus para la primera). */
  Publishing: 'publishing',
  Uploaded: 'uploaded',
  Scheduled: 'scheduled',
  /** Solo alcanzable en TikTok (post_mode inbox): el borrador quedó en la bandeja del usuario, pendiente de que lo complete manualmente. YouTube nunca produce este estado. */
  Inbox: 'inbox',
  Failed: 'failed',
  /** El caso de uso decidió, antes de intentar nada, no subir este item a esta plataforma — hoy solo aplica a videoType=long en TikTok (la plataforma nunca recibe el video largo, solo sus shorts derivados). Nunca se crea un registro en BD para un item Skipped: es un resultado puramente informativo para el caller, no un estado persistido. */
  Skipped: 'skipped',
} as const
export type PublishedVideoStatus = (typeof PublishedVideoStatus)[keyof typeof PublishedVideoStatus]

/**
 * true solo si el video YA EXISTE de verdad en la plataforma — únicamente Uploaded. Scheduled no
 * cuenta (programado a futuro, todavía no es público), Publishing tampoco (intento en curso, sin
 * confirmar), Inbox tampoco (quedó en la bandeja de TikTok, requiere acción manual del usuario
 * para publicarse), AwaitingUpload/Failed tampoco. Único punto de verdad de "ya subido" — evita
 * que cada caller invente su propia lista de exclusión (ver PlanBulkUploadUseCase, que lo usa
 * para no confundir "pendiente/en curso" con "ya subido de verdad").
 */
export function isUploaded(status: PublishedVideoStatus): boolean {
  return status === PublishedVideoStatus.Uploaded
}

/**
 * true si ya existe un intento real para este status — distinto de isPublished: Scheduled
 * (programado a futuro) y Publishing (en curso ahora) e Inbox (pendiente de acción manual)
 * cuentan acá aunque todavía no sean "publicado" de verdad, porque ya representan trabajo real
 * en curso que no hay que duplicar. Solo AwaitingUpload (el propio plan, sin binario subido
 * todavía) y Failed (nunca llegó a existir) quedan libres para crear una fila nueva.
 */
export function blocksNewAttempt(status: PublishedVideoStatus): boolean {
  return status !== PublishedVideoStatus.AwaitingUpload && status !== PublishedVideoStatus.Failed
}

/** Determina la franja horaria/día aplicada por ScheduleUploadPlanService — no es solo metadata descriptiva. */
export const PublishedVideoType = {
  Long: 'long',
  Short: 'short',
} as const
export type PublishedVideoType = (typeof PublishedVideoType)[keyof typeof PublishedVideoType]

export interface PublishedVideoProps {
  id: string
  organizationId: string
  platform: VideoPlatform
  /** Cuenta de plataforma real que publicó (o va a publicar) este video — nunca "la cuenta activa ahora", ver platformAccounts en el schema. */
  platformAccountId: string
  /** El binario real de este sourceId — compartido con cualquier otra fila que publique el mismo sourceId a otra plataforma. Ver SourceUpload. */
  sourceUploadId: string
  /** Agrupa el video largo y sus shorts derivados de una misma serie — distinto de sourceId, que identifica la pieza individual. */
  seriesId: string
  sourceId: string
  videoType: PublishedVideoType
  /** Prioridad relativa (0-1, ignorada para el largo) que decide el orden al calendarizar — ver ScheduleUploadPlanService. */
  priority: number | null
  /** Solo shorts: segundo exacto donde arranca dentro del largo — ver appendLongVideoLink. */
  longVideoTimestampSec: number | null
  /** Solo shorts, opcional: URL del largo ya publicado cuando no viene en este mismo bulk. */
  longVideoUrl: string | null
  metadataRevisionId: string
  /** Id del video ya publicado en la plataforma (youtube videoId / TikTok publicaly_available_post_id) — null hasta que la plataforma confirma. */
  platformVideoId: string | null
  /** Solo TikTok: id devuelto por video/init, necesario para el polling de status/fetch. Siempre null en YouTube. */
  publishId: string | null
  status: PublishedVideoStatus
  /** null para publicación inmediata — no vacío mientras el registro está Scheduled. En YouTube resuelve scheduling nativo (publishAt se manda a la API); en TikTok resuelve scheduling server-side (el binario se guarda y el cron publica al llegar la hora), porque la plataforma no lo soporta nativo. */
  publishAt: Date | null
  /** Opciones específicas de la plataforma sin equivalente universal (ej. TikTok privacyLevel/postMode) — opaco para el dominio compartido, cada VideoUploader interpreta su propio shape. */
  platformOptions: Record<string, unknown> | null
  createdAt: Date
}

/**
 * Tabla mínima: solo IDs y status. No se guarda analytics histórico (views, likes, etc) —
 * eso se consulta en tiempo real contra la API de cada plataforma cuando haga falta mostrarlo.
 */
export class PublishedVideo {
  private constructor(private readonly props: PublishedVideoProps) {}

  static create(props: PublishedVideoProps): PublishedVideo {
    return new PublishedVideo(props)
  }

  get id(): string {
    return this.props.id
  }

  get organizationId(): string {
    return this.props.organizationId
  }

  get platform(): VideoPlatform {
    return this.props.platform
  }

  get platformAccountId(): string {
    return this.props.platformAccountId
  }

  get sourceUploadId(): string {
    return this.props.sourceUploadId
  }

  get seriesId(): string {
    return this.props.seriesId
  }

  get sourceId(): string {
    return this.props.sourceId
  }

  get videoType(): PublishedVideoType {
    return this.props.videoType
  }

  get priority(): number | null {
    return this.props.priority
  }

  get longVideoTimestampSec(): number | null {
    return this.props.longVideoTimestampSec
  }

  get longVideoUrl(): string | null {
    return this.props.longVideoUrl
  }

  get metadataRevisionId(): string {
    return this.props.metadataRevisionId
  }

  get platformVideoId(): string | null {
    return this.props.platformVideoId
  }

  get publishId(): string | null {
    return this.props.publishId
  }

  get status(): PublishedVideoStatus {
    return this.props.status
  }

  get publishAt(): Date | null {
    return this.props.publishAt
  }

  get platformOptions(): Record<string, unknown> | null {
    return this.props.platformOptions
  }

  get createdAt(): Date {
    return this.props.createdAt
  }
}
