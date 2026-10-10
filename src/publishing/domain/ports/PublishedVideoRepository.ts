import { PublishedVideoStatus } from '../entities/PublishedVideo'
import type { PublishedVideo, PublishedVideoType, VideoPlatform } from '../entities/PublishedVideo'

/** withOrganizationLock no admite anidamiento dentro del mismo call stack. */
export class NestedOrganizationLockError extends Error {
  constructor() {
    super('withOrganizationLock cannot be nested within the same call stack')
    this.name = 'NestedOrganizationLockError'
  }
}

/** Ya existe un registro activo (status != failed) para este sourceId en esta cuenta de plataforma — ver el unique index parcial en el schema. Reintentar un sourceId que ya se subió con éxito (o sigue en curso) viola esta invariante; el caller debe evitar reenviar sourceIds ya resueltos. */
export class ActiveUploadAlreadyExistsError extends Error {
  constructor(sourceId: string) {
    super(`An active published_videos record already exists for sourceId: ${sourceId}`)
    this.name = 'ActiveUploadAlreadyExistsError'
  }
}

export interface CreateAwaitingUploadInput {
  organizationId: string
  platform: VideoPlatform
  platformAccountId: string
  sourceUploadId: string
  seriesId: string
  sourceId: string
  videoType: PublishedVideoType
  priority: number | null
  longVideoTimestampSec: number | null
  longVideoUrl: string | null
  metadataRevisionId: string
  platformOptions: Record<string, unknown> | null
}

export interface PublishedVideoRepository {
  /**
   * Serializa "leer cola ocupada + decidir calendario + insertar pendientes" para una
   * organización — sin esto, dos cálculos de calendario concurrentes de la misma organización
   * leerían el mismo estado de slots ocupados y ambos calcularían un calendario válido de forma
   * independiente, violando el techo semanal real. Usa un advisory lock de Postgres (no un
   * SELECT...FOR UPDATE sobre filas, que no bloquea nada si la organización todavía no tiene
   * ninguna fila) para serializar incluso el primer registro de una organización nueva.
   */
  withOrganizationLock<T>(organizationId: string, fn: () => Promise<T>): Promise<T>
  /**
   * Crea todos los registros AwaitingUpload de un bulk en un solo INSERT multi-fila — se llama
   * en el momento de planBulkUpload, antes de que exista ningún SourceUpload todavía (cada item
   * puede apuntar a un SourceUpload que se crea en el mismo flujo, ver BulkUploadPlanningService).
   */
  createManyAwaitingUpload(inputs: CreateAwaitingUploadInput[]): Promise<PublishedVideo[]>
  /** Todos los published_videos (de cualquier plataforma) que referencian este SourceUpload — se resuelve cuando un archivo individual termina de subir, para saber a qué plataformas corresponde publicarlo, o al resumir un plan para no duplicar filas ya creadas (ver planBulkUpload). */
  findBySourceUploadId(sourceUploadId: string): Promise<PublishedVideo[]>
  /** Versión bulk de findBySourceUploadId — una sola query para todos los SourceUpload de un bulk en vez de N llamadas en loop (ver BulkUploadOrchestrator, GetBulkUploadStatusUseCase, ReconcileBulkUploadStatusService, CancelBulkUploadService). */
  findBySourceUploadIds(sourceUploadIds: string[]): Promise<PublishedVideo[]>
  /**
   * TODOS los registros de este sourceId, sin filtrar por status y SIN importar de qué
   * SourceUpload o bulk vengan — a diferencia de findBySourceUploadId, esto detecta un sourceId
   * ya tocado en CUALQUIER bulk pasado (ej. los videos legacy migrados antes de que existiera el
   * concepto de bulk, ver migración 0014), no solo dentro del bulk que se está planificando
   * ahora. El caller (planBulkUpload) decide qué hacer según el status real de cada fila
   * encontrada — Failed no bloquea nada (se puede crear uno nuevo), cualquier otro status sí
   * representa un intento ya resuelto o en curso que no se debe duplicar.
   */
  findBySourceId(sourceId: string): Promise<PublishedVideo[]>
  /** Versión bulk de findBySourceId — una sola query para todos los sourceId de un plan en vez de N llamadas en loop (ver PlanBulkUploadUseCase). */
  findBySourceIds(sourceIds: string[]): Promise<PublishedVideo[]>
  /**
   * Transición AwaitingUpload -> Publishing o AwaitingUpload -> Scheduled, fijando el publishAt
   * ya calculado por ScheduleUploadPlanService — se llama una vez que TODOS los SourceUpload de
   * un bulk llegaron a Completed. nextStatus lo decide el caller: Publishing si el intento real
   * va a ocurrir ahora mismo (publicación inmediata, o scheduling nativo con publishAt futuro);
   * Scheduled si no hay scheduling nativo y hay que esperar al cron (ver PublishScheduledVideosUseCase).
   */
  assignScheduleAndStartPublishing(
    id: string,
    publishAt: Date | null,
    nextStatus: typeof PublishedVideoStatus.Publishing | typeof PublishedVideoStatus.Scheduled,
  ): Promise<PublishedVideo>
  /** Confirma que la plataforma ya aceptó el video — se llama después de un intento de publicación exitoso. Scoped por organizationId igual que el resto del repositorio (multi-tenancy estricta). publishId solo aplica a TikTok (null en YouTube). */
  markUploaded(
    organizationId: string,
    id: string,
    platformVideoId: string | null,
    status: PublishedVideoStatus,
    publishId: string | null,
  ): Promise<PublishedVideo>
  /** Marca el intento como fallido (la publicación nunca se confirmó en la plataforma). */
  markFailed(organizationId: string, id: string): Promise<PublishedVideo>
  /** Transición atómica scheduled -> publishing, solo si sigue scheduled — evita que el cron de reconciliación de TikTok publique el mismo registro dos veces si corre concurrentemente. Devuelve null si ya no estaba scheduled. */
  claimScheduledForUpload(organizationId: string, id: string): Promise<PublishedVideo | null>
  /**
   * Cola compartida por organización y plataforma: toda pieza que ya ocupa (o va a ocupar) un
   * slot semanal — Publishing/Uploaded/Inbox sin publishAt (publicación inmediata) o Scheduled
   * con publishAt futuro. Excluye Failed directamente en la query. Usado por
   * ScheduleUploadPlanService para no violar el techo semanal ni chocar contra series ya en curso.
   */
  findOccupyingSlotsByOrganizationId(organizationId: string, platform: VideoPlatform, now: Date): Promise<PublishedVideo[]>
  /** El video Long de esta seriesId+platform ya publicado (platformVideoId no nulo) — consulta puntual en vez de traer toda la cola de slots ocupados de la organización para filtrarla en memoria (ver BulkUploadOrchestrator.findPublishedLongVideoUrlInSeries). null si el largo todavía no se publicó o no existe en esta serie/plataforma. */
  findPublishedLongVideoInSeries(seriesId: string, platform: VideoPlatform): Promise<PublishedVideo | null>
  /** Registros Scheduled cuyo publishAt ya venció, para una plataforma — recorridos por el cron de publicación programada (usado por TikTok; YouTube resuelve scheduling nativo y nunca deja filas Scheduled vencidas para este método). */
  findDueScheduled(platform: VideoPlatform, now: Date): Promise<PublishedVideo[]>
  /** Busca el registro por publishId (solo aplica a plataformas con resolución asíncrona por webhook, ver PublishedVideo.publishId) — usado por HandlePlatformWebhookUseCase para resolver qué registro actualizar sin conocer organizationId de antemano (el webhook no lo trae). null si no existe. */
  findByPublishId(publishId: string): Promise<PublishedVideo | null>
}
