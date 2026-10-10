import type { BulkUpload } from '../entities/BulkUpload'

export class BulkUploadAlreadyActiveError extends Error {
  constructor(seriesId: string) {
    super(`A bulk upload is already active for seriesId: ${seriesId}`)
    this.name = 'BulkUploadAlreadyActiveError'
  }
}

export interface BulkUploadRepository {
  /** Crea un bulk nuevo en status Active — lanza BulkUploadAlreadyActiveError si ya existe uno activo para este seriesId (ver unique index parcial en el schema). */
  create(organizationId: string, seriesId: string, timeZone: string, longVideoPublishDay: Date): Promise<BulkUpload>
  findById(id: string): Promise<BulkUpload | null>
  /** El único bulk Active para este seriesId, si existe — para devolver las URLs de upload ya existentes en vez de duplicar un bulk nuevo. */
  findActiveBySeriesId(seriesId: string): Promise<BulkUpload | null>
  /** El bulk más reciente de este seriesId sin importar su status — un seriesId solo tiene un Active a la vez, pero puede tener históricos ya resueltos (ver GetBulkUploadStatusUseCase, que necesita mostrar el estado real incluso después de que terminó de subir). */
  findMostRecentBySeriesId(seriesId: string): Promise<BulkUpload | null>
  /** Toca lastActivityAt a `now` — se llama en cada evento de actividad real (PATCH de tus) de cualquier SourceUpload del bulk, reiniciando el plazo de expiración del bulk completo. */
  touchActivity(id: string, now: Date): Promise<void>
  /** Active -> Uploaded: todos los SourceUpload del bulk terminaron de subir — se marca sin importar el resultado de publicación, que se resuelve por separado (ver markPublishingResolved). */
  markUploaded(id: string): Promise<void>
  /** Uploaded/CompletedWithFailures -> Publishing: hay al menos un intento de publicación en curso o reintentable. */
  markPublishing(id: string): Promise<void>
  /** Publishing -> Completed o CompletedWithFailures según allSucceeded — se llama cada vez que se termina de recorrer el conjunto de publicaciones pendientes de un bulk (plan inicial o reintento). */
  markPublishingResolved(id: string, allSucceeded: boolean): Promise<void>
  /** Bulks Active cuyo lastActivityAt es anterior a `olderThan` — recorridos por el cron de expiración diario. */
  findStaleActive(olderThan: Date): Promise<BulkUpload[]>
  markExpired(id: string): Promise<void>
}
