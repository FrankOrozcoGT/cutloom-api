import type { YouTubeVideo, YouTubeVideoStatus, YouTubeVideoType } from '../entities/YouTubeVideo'

/** withOrganizationLock no admite anidamiento dentro del mismo call stack — ver YouTubeVideoRepository.withOrganizationLock. Error de dominio propio, no un detalle de la implementación de infraestructura (advisory lock/transacción) que lo detecta. */
export class NestedOrganizationLockError extends Error {
  constructor() {
    super('withOrganizationLock cannot be nested within the same call stack')
    this.name = 'NestedOrganizationLockError'
  }
}

/** Ya existe un registro activo (status != failed) para este sourceId — ver el unique index parcial en el schema. Reintentar un sourceId que ya se subió con éxito (o sigue en curso) viola esta invariante; el caller debe evitar reenviar sourceIds ya resueltos. */
export class ActiveUploadAlreadyExistsError extends Error {
  constructor(sourceId: string) {
    super(`An active youtube_videos record already exists for sourceId: ${sourceId}`)
    this.name = 'ActiveUploadAlreadyExistsError'
  }
}

export interface CreatePendingYouTubeVideoInput {
  organizationId: string
  seriesId: string
  sourceId: string
  videoType: YouTubeVideoType
  metadataRevisionId: string
  publishAt: Date | null
}

export interface YouTubeVideoRepository {
  /**
   * Serializa "leer cola ocupada + decidir calendario + insertar pendientes" para una
   * organización — sin esto, dos bulk-uploads concurrentes de la misma organización leerían
   * el mismo estado de slots ocupados y ambos calcularían un calendario válido de forma
   * independiente, violando el techo semanal real. Usa un advisory lock de Postgres (no un
   * SELECT...FOR UPDATE sobre filas, que no bloquea nada si la organización todavía no tiene
   * ningún youtube_videos) para serializar incluso el primer bulk-upload de una organización
   * nueva sin filas previas.
   */
  withOrganizationLock<T>(organizationId: string, fn: () => Promise<T>): Promise<T>
  /** Crea todos los registros Uploading de un bulk en un solo INSERT multi-fila, antes de intentar el upload a YouTube — ver YouTubeVideoStatus.Uploading. */
  createManyPending(inputs: CreatePendingYouTubeVideoInput[]): Promise<YouTubeVideo[]>
  /** Confirma que YouTube ya aceptó el video — se llama después de un upload exitoso. Scoped por organizationId igual que el resto del repositorio (multi-tenancy estricta). */
  markUploaded(organizationId: string, id: string, youtubeVideoId: string, status: YouTubeVideoStatus): Promise<YouTubeVideo>
  /** Marca el intento como fallido (el upload a YouTube nunca se confirmó). */
  markFailed(organizationId: string, id: string): Promise<YouTubeVideo>
  /**
   * Cola compartida por organización: toda pieza que ya ocupa (o va a ocupar) un slot semanal
   * del canal — Uploading/Uploaded sin publishAt (publicación inmediata, ya en el canal) o
   * Scheduled con publishAt futuro. Excluye Failed (nunca llegó a publicarse) directamente en
   * la query. Usado por ScheduleUploadPlanService para no violar el techo semanal ni chocar
   * contra series ya en curso.
   */
  findOccupyingSlotsByOrganizationId(organizationId: string, now: Date): Promise<YouTubeVideo[]>
  /**
   * Reconciliación: un registro que sigue en Uploading más allá de un tiempo razonable
   * significa que el proceso crasheó o el cliente cortó la conexión a mitad del upload real a
   * YouTube (el advisory lock de withOrganizationLock ya se liberó mucho antes de esa etapa,
   * así que nada más lo detecta). Sin esto, esos registros ocupan slots semanales para
   * siempre (ver findOccupyingSlotsByOrganizationId). Se marcan Failed — no hay forma de
   * saber si el upload real llegó a completarse en YouTube sin consultar su API, y eso queda
   * fuera de este mecanismo de limpieza.
   */
  expireStaleUploading(olderThan: Date): Promise<number>
}
