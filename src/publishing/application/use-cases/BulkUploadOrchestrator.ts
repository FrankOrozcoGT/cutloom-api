import type { YouTubeMetadata } from '../../domain/entities/ContentRevision'
import { PublishedVideoStatus, PublishedVideoType, VideoPlatform, type PublishedVideo } from '../../domain/entities/PublishedVideo'
import type { BulkUploadRepository } from '../../domain/ports/BulkUploadRepository'
import type { SourceUploadRepository } from '../../domain/ports/SourceUploadRepository'
import type { SourceUploadBinaryReader } from '../../domain/ports/SourceUploadBinaryReader'
import type { PublishedVideoRepository } from '../../domain/ports/PublishedVideoRepository'
import type { ContentRevisionRepository } from '../../domain/ports/ContentRevisionRepository'
import type { PlatformCredentialResolver } from '../../domain/ports/PlatformCredentialResolver'
import type { VideoUploader } from '../../domain/ports/VideoUploader'
import { VideoUploadQuotaExceededError, VideoUploadRejectedError, VideoUploadTokenExpiredError } from '../../domain/ports/VideoUploader'
import {
  SchedulePieceType,
  ScheduleCapacityExceededError,
  ScheduleUploadPlanService,
  type ScheduleSlotItem,
} from '../services/ScheduleUploadPlanService'
import { appendLongVideoLink, buildLongVideoLink } from '../services/appendLongVideoLink'
import type { NotificationRepository } from '../../../shared/domain/ports/NotificationRepository'
import type { NotificationPublisher } from '../../../shared/domain/ports/NotificationPublisher'
import { NotificationType } from '../../../shared/domain/entities/Notification'
import type { Logger } from '../../../shared/domain/ports/Logger'
import type { DeleteBinaryIfAllPlatformsResolvedService } from '../services/DeleteBinaryIfAllPlatformsResolvedService'
import type { ReconcileBulkUploadStatusService } from '../services/ReconcileBulkUploadStatusService'

const TIKTOK_STUDIO_URL = 'https://www.tiktok.com/tiktokstudio/content'

/**
 * Reacciona a los dos eventos que produce el servidor tus (ver TusBulkUploadHandler):
 * actividad (cualquier PATCH recibido) y finalización de un archivo. Es el único lugar que
 * decide "ya se puede calendarizar y publicar este bulk" — recién cuando TODOS sus SourceUpload
 * llegaron a Completed, nunca antes, porque ScheduleUploadPlanService necesita ver el conjunto
 * completo de items para intercalarlos bien (ver ScheduleUploadPlanService.plan).
 *
 * Reemplaza por completo al viejo BulkUploadVideoUseCase/BulkUploadSession: ya no hay una
 * "sesión" ligada a un único request HTTP — el bulk vive en BD entre uploads tus independientes
 * que pueden tardar minutos, horas o días en completarse.
 */
export class BulkUploadOrchestrator {
  constructor(
    private readonly bulkUploadRepository: BulkUploadRepository,
    private readonly sourceUploadRepository: SourceUploadRepository,
    private readonly binaryReader: SourceUploadBinaryReader,
    private readonly publishedVideoRepository: PublishedVideoRepository,
    private readonly contentRevisionRepository: ContentRevisionRepository,
    private readonly credentialResolverByPlatform: Record<VideoPlatform, PlatformCredentialResolver>,
    private readonly uploaderByPlatform: Record<VideoPlatform, VideoUploader>,
    private readonly supportsNativeSchedulingByPlatform: Record<VideoPlatform, boolean>,
    private readonly scheduleUploadPlanService: ScheduleUploadPlanService,
    private readonly notificationRepository: NotificationRepository,
    private readonly notificationPublisher: NotificationPublisher,
    private readonly deleteBinaryIfAllPlatformsResolved: DeleteBinaryIfAllPlatformsResolvedService,
    private readonly reconcileBulkUploadStatus: ReconcileBulkUploadStatusService,
    private readonly logger: Logger,
  ) {}

  /** Cualquier PATCH real recibido por tus — reinicia el plazo de expiración de TODO el bulk, no solo del archivo que recibió el chunk (ver bulkUploads.lastActivityAt). */
  async onSourceUploadActivity(tusUploadId: string, now: Date): Promise<void> {
    const sourceUpload = await this.sourceUploadRepository.findByTusUploadId(tusUploadId)
    if (!sourceUpload) return
    await this.bulkUploadRepository.touchActivity(sourceUpload.bulkUploadId, now)
  }

  /** Reintenta todo PublishedVideo Failed de este bulk — a pedido explícito del frontend, nunca automático (ver RetryFailedPublicationsUseCase). */
  async retryFailed(bulkUploadId: string): Promise<void> {
    const sourceUploads = await this.sourceUploadRepository.findByBulkUploadId(bulkUploadId)
    const allVideos = await this.publishedVideoRepository.findBySourceUploadIds(sourceUploads.map((sourceUpload) => sourceUpload.id))
    const failedVideos = allVideos.filter((video) => video.status === PublishedVideoStatus.Failed)
    if (failedVideos.length === 0) return

    await this.bulkUploadRepository.markPublishing(bulkUploadId)
    for (const video of failedVideos) {
      const scheduled = await this.publishedVideoRepository.assignScheduleAndStartPublishing(
        video.id,
        video.publishAt,
        PublishedVideoStatus.Publishing,
      )
      await this.publishOne(scheduled)
    }
    await this.reconcileBulkUploadStatus.execute(bulkUploadId)
  }

  /** Un archivo individual terminó de subir (tus onUploadFinish) — si es el último del bulk, dispara calendarización + publicación real de TODO el conjunto. */
  async onSourceUploadCompleted(tusUploadId: string): Promise<void> {
    const sourceUpload = await this.sourceUploadRepository.findByTusUploadId(tusUploadId)
    if (!sourceUpload) {
      this.logger.error({ tusUploadId }, '[BulkUploadOrchestrator] onSourceUploadCompleted: no source_uploads row for this tus upload')
      return
    }

    await this.sourceUploadRepository.markCompleted(sourceUpload.id)

    const allCompleted = await this.sourceUploadRepository.allCompletedForBulkUpload(sourceUpload.bulkUploadId)
    if (!allCompleted) return

    await this.bulkUploadRepository.markUploaded(sourceUpload.bulkUploadId)
    await this.publishBulk(sourceUpload.bulkUploadId)
  }

  private async publishBulk(bulkUploadId: string): Promise<void> {
    const bulkUpload = await this.bulkUploadRepository.findById(bulkUploadId)
    if (!bulkUpload) {
      this.logger.error({ bulkUploadId }, '[BulkUploadOrchestrator] publishBulk: bulk_uploads row not found')
      return
    }

    const sourceUploads = await this.sourceUploadRepository.findByBulkUploadId(bulkUploadId)
    const allVideos = await this.publishedVideoRepository.findBySourceUploadIds(sourceUploads.map((sourceUpload) => sourceUpload.id))
    const awaitingVideos = allVideos.filter((video) => video.status === PublishedVideoStatus.AwaitingUpload)
    if (awaitingVideos.length === 0) return

    await this.bulkUploadRepository.markPublishing(bulkUploadId)
    const videosByPlatform = this.groupByPlatform(awaitingVideos)

    for (const [platform, videos] of videosByPlatform) {
      let readyToPublish: PublishedVideo[]
      try {
        // withOrganizationLock sostiene una transacción Postgres real (advisory lock liberado
        // solo al commit) — por eso acá adentro solo se calcula el calendario y se transiciona
        // estado en BD, nunca se llama a publishOne (streaming de hasta 20GB a la plataforma):
        // eso mantendría la transacción abierta durante toda la subida y agotaría el pool bajo
        // pocas subidas concurrentes. Los videos que quedan listos para publicar ahora mismo se
        // acumulan y se procesan recién después de que el lock ya se liberó.
        readyToPublish = await this.publishedVideoRepository.withOrganizationLock(bulkUpload.organizationId, async () => {
          const occupyingSlots = await this.publishedVideoRepository.findOccupyingSlotsByOrganizationId(
            bulkUpload.organizationId,
            platform,
            new Date(),
          )
          const scheduleItems: ScheduleSlotItem[] = videos.map((video) => ({
            sourceId: video.sourceId,
            videoType: video.videoType === PublishedVideoType.Long ? SchedulePieceType.Long : SchedulePieceType.Short,
            priority: video.priority,
          }))
          const publishAtBySourceId = new Map(
            this.scheduleUploadPlanService
              .plan(
                {
                  organizationId: bulkUpload.organizationId,
                  timeZone: bulkUpload.timeZone,
                  longVideoPublishDay: bulkUpload.longVideoPublishDay,
                  items: scheduleItems,
                },
                occupyingSlots,
              )
              .map((slot) => [slot.sourceId, slot.publishAt]),
          )

          const supportsNativeScheduling = this.supportsNativeSchedulingByPlatform[platform]
          const scheduledReadyToPublish: PublishedVideo[] = []
          for (const video of videos) {
            const publishAt = publishAtBySourceId.get(video.sourceId) ?? null
            // Sin scheduling nativo y con fecha futura: el intento real lo hace el cron de
            // PublishScheduledVideosUseCase al llegar publishAt, no acá — el registro debe quedar
            // Scheduled (lo que esa query recorre), nunca Publishing (que implicaría un intento
            // en curso que en realidad nunca se hizo).
            const nextStatus =
              publishAt && !supportsNativeScheduling ? PublishedVideoStatus.Scheduled : PublishedVideoStatus.Publishing
            const scheduled = await this.publishedVideoRepository.assignScheduleAndStartPublishing(video.id, publishAt, nextStatus)
            if (nextStatus === PublishedVideoStatus.Publishing) {
              scheduledReadyToPublish.push(scheduled)
            }
          }
          return scheduledReadyToPublish
        })
      } catch (error) {
        if (!(error instanceof ScheduleCapacityExceededError)) throw error
        this.logger.error({ bulkUploadId, platform }, '[BulkUploadOrchestrator] publishBulk: schedule capacity exceeded')
        const notification = await this.notificationRepository.create({
          organizationId: bulkUpload.organizationId,
          type: NotificationType.BulkUploadScheduleFailed,
          data: { seriesId: bulkUpload.seriesId },
        })
        this.notificationPublisher.publish(notification)
        continue
      }

      for (const video of readyToPublish) {
        await this.publishOne(video)
      }
    }

    await this.reconcileBulkUploadStatus.execute(bulkUploadId)
  }

  private async publishOne(video: PublishedVideo): Promise<void> {
    const supportsNativeScheduling = this.supportsNativeSchedulingByPlatform[video.platform]

    const sourceUpload = await this.sourceUploadRepository.findById(video.sourceUploadId)
    if (!sourceUpload) {
      await this.publishedVideoRepository.markFailed(video.organizationId, video.id)
      await this.deleteBinaryIfAllPlatformsResolved.execute(video.sourceUploadId)
      return
    }

    const [revision] = await this.contentRevisionRepository.findByIds(video.organizationId, [video.metadataRevisionId])
    if (!revision) {
      await this.publishedVideoRepository.markFailed(video.organizationId, video.id)
      await this.deleteBinaryIfAllPlatformsResolved.execute(video.sourceUploadId)
      return
    }

    try {
      const accessToken = await this.credentialResolverByPlatform[video.platform].resolveAccessToken(video.platformAccountId)
      const videoSize = await this.binaryReader.size(sourceUpload.tusUploadId)
      const videoStream = await this.binaryReader.open(sourceUpload.tusUploadId)
      const metadata = await this.resolveMetadataWithLongVideoLink(video, revision.metadata)

      const result = await this.uploaderByPlatform[video.platform].upload({
        accessToken,
        videoStream,
        videoSize,
        metadata,
        publishAt: supportsNativeScheduling ? video.publishAt : null,
        platformOptions: video.platformOptions,
      })

      await this.publishedVideoRepository.markUploaded(video.organizationId, video.id, result.platformVideoId, result.status, result.publishId)

      if (result.pendingManualAction) {
        const notification = await this.notificationRepository.create({
          organizationId: video.organizationId,
          type: NotificationType.TikTokDraftReady,
          data: { sourceId: video.sourceId, seriesId: video.seriesId, tikTokInboxUrl: TIKTOK_STUDIO_URL },
        })
        this.notificationPublisher.publish(notification)
      } else if (result.status !== PublishedVideoStatus.Publishing) {
        await this.deleteBinaryIfAllPlatformsResolved.execute(video.sourceUploadId)
        const videoUrl = this.buildPublishedVideoUrl(video.platform, result.platformVideoId)
        const notification = await this.notificationRepository.create({
          organizationId: video.organizationId,
          type: NotificationType.VideoPublished,
          data: { sourceId: video.sourceId, seriesId: video.seriesId, platform: video.platform, videoUrl },
        })
        this.notificationPublisher.publish(notification)
      }
    } catch (error) {
      const reason =
        error instanceof VideoUploadQuotaExceededError
          ? 'QuotaExceeded'
          : error instanceof VideoUploadTokenExpiredError
            ? 'TokenExpired'
            : error instanceof VideoUploadRejectedError
              ? error.message
              : error instanceof Error
                ? error.message
                : 'UnknownError'
      this.logger.error({ sourceId: video.sourceId, platform: video.platform, reason }, '[BulkUploadOrchestrator] publishOne failed')
      await this.publishedVideoRepository.markFailed(video.organizationId, video.id)
      await this.deleteBinaryIfAllPlatformsResolved.execute(video.sourceUploadId)
      const notification = await this.notificationRepository.create({
        organizationId: video.organizationId,
        type: NotificationType.VideoUploadFailed,
        data: { sourceId: video.sourceId, seriesId: video.seriesId, platform: video.platform, failReason: reason },
      })
      this.notificationPublisher.publish(notification)
    }
  }

  /**
   * Agrega a la descripción el link al video largo + offset "2 minutos antes" — solo para
   * shorts, solo si hay suficiente info para resolverlo. Prioridad: longVideoUrl explícito del
   * plan original > el largo de la misma serie/plataforma ya publicado en este mismo bulk. Si
   * no hay ninguno (ej. el short no tiene video largo asociado, o el largo todavía no se
   * publicó), la metadata se usa sin modificar — no es un error.
   */
  private async resolveMetadataWithLongVideoLink(video: PublishedVideo, metadata: YouTubeMetadata): Promise<YouTubeMetadata> {
    if (video.videoType !== PublishedVideoType.Short || video.longVideoTimestampSec === null) return metadata

    const baseUrl = video.longVideoUrl ?? (await this.findPublishedLongVideoUrlInSeries(video))
    if (!baseUrl) return metadata

    const link = buildLongVideoLink(video.platform, baseUrl, video.longVideoTimestampSec)
    return appendLongVideoLink(metadata, link)
  }

  private async findPublishedLongVideoUrlInSeries(video: PublishedVideo): Promise<string | null> {
    const longVideo = await this.publishedVideoRepository.findPublishedLongVideoInSeries(video.seriesId, video.platform)
    return longVideo?.platformVideoId ? this.buildPlatformVideoUrl(video.platform, longVideo.platformVideoId) : null
  }

  private buildPlatformVideoUrl(platform: VideoPlatform, platformVideoId: string): string {
    if (platform === VideoPlatform.YouTube) return `https://www.youtube.com/watch?v=${platformVideoId}`
    return `https://www.tiktok.com/tiktokstudio/upload/post/${platformVideoId}`
  }

  private buildPublishedVideoUrl(platform: VideoPlatform, platformVideoId: string | null): string | null {
    return platformVideoId ? this.buildPlatformVideoUrl(platform, platformVideoId) : null
  }

  private groupByPlatform(videos: PublishedVideo[]): Map<VideoPlatform, PublishedVideo[]> {
    const map = new Map<VideoPlatform, PublishedVideo[]>()
    for (const video of videos) {
      const list = map.get(video.platform) ?? []
      list.push(video)
      map.set(video.platform, list)
    }
    return map
  }
}
