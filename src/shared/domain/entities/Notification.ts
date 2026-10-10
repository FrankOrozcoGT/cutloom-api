/**
 * Discriminante de tipo — cada valor define su propio shape de `data` (ver NotificationData).
 * Nuevo tipo de notificación = agregar un caso acá + su interfaz de data correspondiente, sin
 * tocar la tabla ni el resto del sistema de notificaciones.
 */
export const NotificationType = {
  /**
   * TikTok confirmó (vía webhook post.publish.complete) que el video subido por el cron de
   * publicación diferida quedó como borrador privado en la bandeja del usuario — no es un
   * fallo, se subió bien, pero como la app de Cutloom no está auditada por TikTok no puede
   * quedar público solo. Alguien tiene que entrar a la app de TikTok y apretar publicar (o
   * ponerle horario) para completarlo. Exclusivo de TikTok — ninguna otra plataforma produce
   * este estado intermedio, por eso no está generalizado como VideoPublished/VideoUploadFailed.
   */
  TikTokDraftReady: 'tiktok_draft_ready',
  /**
   * El video quedó público (o programado con scheduling nativo) en la plataforma — mismo
   * mecanismo sin importar cuál: YouTube lo confirma de forma síncrona en la misma llamada de
   * subida (ver BulkUploadOrchestrator.publishOne); TikTok lo confirma después, vía webhook
   * (ver HandleTikTokWebhookUseCase) — ambos casos emiten este mismo tipo, con `platform` en el
   * data para que el frontend arme el link/mensaje correcto.
   */
  VideoPublished: 'video_published',
  /** El intento de publicación falló — nunca llegó a existir en la plataforma. Mismo mecanismo para cualquier plataforma: YouTube lo detecta en la misma llamada de subida; TikTok vía webhook post.publish.failed. */
  VideoUploadFailed: 'video_upload_failed',
  /** No se pudo calendarizar NINGÚN item del bulk (ScheduleCapacityExceededError) — el calendario
   * de la organización está saturado más allá de lo que ScheduleUploadPlanService puede resolver
   * buscando hacia adelante. A diferencia de VideoUploadFailed (un item puntual), esto bloquea el
   * bulk completo antes de intentar publicar nada — ver BulkUploadOrchestrator.publishBulk. */
  BulkUploadScheduleFailed: 'bulk_upload_schedule_failed',
} as const
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType]

interface TikTokDraftReadyData {
  sourceId: string
  seriesId: string
  /** Link a la bandeja de TikTok del usuario, para que entre directo a terminar de publicar — ver PublishScheduledVideosUseCase. */
  tikTokInboxUrl: string
}

interface VideoPublishedData {
  sourceId: string
  seriesId: string
  platform: 'youtube' | 'tiktok'
  /** Link directo al video publicado — null si la plataforma no devolvió un id público (ej. TikTok Inbox que luego se resuelve por webhook). */
  videoUrl: string | null
}

interface VideoUploadFailedData {
  sourceId: string
  seriesId: string
  platform: 'youtube' | 'tiktok'
  /** Razón textual si la plataforma la dio (ej. TikTok status/fetch.fail_reason) — null si no hay detalle disponible. */
  failReason: string | null
}

interface BulkUploadScheduleFailedData {
  seriesId: string
}

/** Shape de `data` según `type` — el dominio compartido conoce todos los tipos posibles (a diferencia de platformOptions/platformAccountInfo, que son opacos para el dominio y solo el adaptador de cada proveedor los interpreta). */
export type NotificationData = {
  [NotificationType.TikTokDraftReady]: TikTokDraftReadyData
  [NotificationType.VideoPublished]: VideoPublishedData
  [NotificationType.VideoUploadFailed]: VideoUploadFailedData
  [NotificationType.BulkUploadScheduleFailed]: BulkUploadScheduleFailedData
}

export interface NotificationProps<T extends NotificationType = NotificationType> {
  id: string
  organizationId: string
  type: T
  data: NotificationData[T]
  read: boolean
  createdAt: Date
}

export class Notification<T extends NotificationType = NotificationType> {
  private constructor(private readonly props: NotificationProps<T>) {}

  static create<T extends NotificationType>(props: NotificationProps<T>): Notification<T> {
    return new Notification(props)
  }

  get id(): string {
    return this.props.id
  }

  get organizationId(): string {
    return this.props.organizationId
  }

  get type(): T {
    return this.props.type
  }

  get data(): NotificationData[T] {
    return this.props.data
  }

  get read(): boolean {
    return this.props.read
  }

  get createdAt(): Date {
    return this.props.createdAt
  }
}
