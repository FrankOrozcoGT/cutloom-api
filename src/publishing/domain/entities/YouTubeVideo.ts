export const YouTubeVideoStatus = {
  /** Registro creado antes de intentar el upload a YouTube — permite reconciliar si el upload
   * a YouTube tiene éxito pero la confirmación posterior (markUploaded) falla: el video nunca
   * queda huérfano (público en YouTube sin ningún rastro local), solo atascado en Uploading. */
  Uploading: 'uploading',
  Uploaded: 'uploaded',
  Scheduled: 'scheduled',
  Failed: 'failed',
} as const
export type YouTubeVideoStatus = (typeof YouTubeVideoStatus)[keyof typeof YouTubeVideoStatus]

/** Determina la franja horaria/día aplicada por ScheduleUploadPlanService — no es solo metadata descriptiva. */
export const YouTubeVideoType = {
  Long: 'long',
  Short: 'short',
} as const
export type YouTubeVideoType = (typeof YouTubeVideoType)[keyof typeof YouTubeVideoType]

export interface YouTubeVideoProps {
  id: string
  organizationId: string
  /** Agrupa el video largo y sus shorts derivados de una misma serie — distinto de sourceId, que identifica la pieza individual. */
  seriesId: string
  sourceId: string
  videoType: YouTubeVideoType
  metadataRevisionId: string
  youtubeVideoId: string | null
  status: YouTubeVideoStatus
  publishAt: Date | null
  createdAt: Date
}

/**
 * Tabla mínima: solo IDs y status. No se guarda analytics histórico (views, likes, etc) —
 * eso se consulta en tiempo real contra YouTube Data API cuando haga falta mostrarlo.
 */
export class YouTubeVideo {
  private constructor(private readonly props: YouTubeVideoProps) {}

  static create(props: YouTubeVideoProps): YouTubeVideo {
    return new YouTubeVideo(props)
  }

  get id(): string {
    return this.props.id
  }

  get organizationId(): string {
    return this.props.organizationId
  }

  get seriesId(): string {
    return this.props.seriesId
  }

  get sourceId(): string {
    return this.props.sourceId
  }

  get videoType(): YouTubeVideoType {
    return this.props.videoType
  }

  get metadataRevisionId(): string {
    return this.props.metadataRevisionId
  }

  get youtubeVideoId(): string | null {
    return this.props.youtubeVideoId
  }

  get status(): YouTubeVideoStatus {
    return this.props.status
  }

  get publishAt(): Date | null {
    return this.props.publishAt
  }

  get createdAt(): Date {
    return this.props.createdAt
  }
}
