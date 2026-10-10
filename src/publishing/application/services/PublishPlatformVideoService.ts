import type { YouTubeMetadata } from '../../domain/entities/ContentRevision'
import { PublishedVideoStatus, PublishedVideoType, VideoPlatform, type PublishedVideo } from '../../domain/entities/PublishedVideo'
import type { SourceUploadRepository } from '../../domain/ports/SourceUploadRepository'
import type { SourceUploadBinaryReader } from '../../domain/ports/SourceUploadBinaryReader'
import type { PublishedVideoRepository } from '../../domain/ports/PublishedVideoRepository'
import type { ContentRevisionRepository } from '../../domain/ports/ContentRevisionRepository'
import type { PlatformCredentialResolver } from '../../domain/ports/PlatformCredentialResolver'
import type { VideoUploader } from '../../domain/ports/VideoUploader'
import { VideoUploadQuotaExceededError, VideoUploadRejectedError, VideoUploadTokenExpiredError } from '../../domain/ports/VideoUploader'
import { appendLongVideoLink, buildLongVideoLink } from './appendLongVideoLink'
import type { NotificationRepository } from '../../../shared/domain/ports/NotificationRepository'
import type { NotificationPublisher } from '../../../shared/domain/ports/NotificationPublisher'
import { NotificationType } from '../../../shared/domain/entities/Notification'
import type { Logger } from '../../../shared/domain/ports/Logger'
import type { DeleteBinaryIfAllPlatformsResolvedService } from './DeleteBinaryIfAllPlatformsResolvedService'
import type { ReconcileBulkUploadStatusService } from './ReconcileBulkUploadStatusService'

const TIKTOK_STUDIO_URL = 'https://www.tiktok.com/tiktokstudio/content'

/**
 * Único lugar que sube un PublishedVideo ya en status Publishing a su plataforma real y resuelve
 * su estado final — usado tanto por BulkUploadOrchestrator (publicación inmediata/scheduling
 * nativo) como por PublishScheduledVideosUseCase (cron de scheduling server-side para
 * plataformas sin scheduling nativo, ej. TikTok). Antes estaba duplicado entero en ambos.
 */
export class PublishPlatformVideoService {
  constructor(
    private readonly sourceUploadRepository: SourceUploadRepository,
    private readonly binaryReader: SourceUploadBinaryReader,
    private readonly publishedVideoRepository: PublishedVideoRepository,
    private readonly contentRevisionRepository: ContentRevisionRepository,
    private readonly credentialResolverByPlatform: Record<VideoPlatform, PlatformCredentialResolver>,
    private readonly uploaderByPlatform: Record<VideoPlatform, VideoUploader>,
    private readonly supportsNativeSchedulingByPlatform: Record<VideoPlatform, boolean>,
    private readonly notificationRepository: NotificationRepository,
    private readonly notificationPublisher: NotificationPublisher,
    private readonly deleteBinaryIfAllPlatformsResolved: DeleteBinaryIfAllPlatformsResolvedService,
    private readonly reconcileBulkUploadStatus: ReconcileBulkUploadStatusService,
    private readonly logger: Logger,
  ) {}

  /** true si la plataforma aceptó el video (o quedó en inbox pendiente de acción manual) — false si el intento falló. El estado real siempre queda persistido en BD sin importar el retorno; esto es solo para que el caller pueda contar éxitos/fallos sin volver a leer la fila. */
  async publish(video: PublishedVideo): Promise<boolean> {
    const supportsNativeScheduling = this.supportsNativeSchedulingByPlatform[video.platform]

    const sourceUpload = await this.sourceUploadRepository.findById(video.sourceUploadId)
    if (!sourceUpload) {
      // No hay bulkUploadId disponible sin la fila de SourceUpload — este caso (video en
      // Publishing cuyo SourceUpload ya no existe) es una inconsistencia de datos, no el camino
      // feliz; se marca Failed igual pero sin poder reconciliar el bulk.
      await this.publishedVideoRepository.markFailed(video.organizationId, video.id)
      await this.deleteBinaryIfAllPlatformsResolved.execute(video.sourceUploadId)
      return false
    }

    const [revision] = await this.contentRevisionRepository.findByIds(video.organizationId, [video.metadataRevisionId])
    if (!revision) {
      await this.publishedVideoRepository.markFailed(video.organizationId, video.id)
      await this.deleteBinaryIfAllPlatformsResolved.execute(video.sourceUploadId)
      await this.reconcileBulkUploadStatus.execute(sourceUpload.bulkUploadId)
      return false
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
        // Resultado ya terminal en esta misma llamada (YouTube siempre; TikTok cuando no cae a
        // inbox pendiente de webhook) — recién acá tiene sentido reconciliar el bulk. Si quedó
        // Publishing (TikTok esperando post.publish.complete/failed), el webhook lo hará él
        // mismo cuando resuelva (ver HandleTikTokWebhookUseCase).
        await this.deleteBinaryIfAllPlatformsResolved.execute(video.sourceUploadId)
        await this.reconcileBulkUploadStatus.execute(sourceUpload.bulkUploadId)
        const videoUrl = this.buildPublishedVideoUrl(video.platform, result.platformVideoId)
        const notification = await this.notificationRepository.create({
          organizationId: video.organizationId,
          type: NotificationType.VideoPublished,
          data: { sourceId: video.sourceId, seriesId: video.seriesId, platform: video.platform, videoUrl },
        })
        this.notificationPublisher.publish(notification)
      }
      return true
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
      this.logger.error({ sourceId: video.sourceId, platform: video.platform, reason }, '[PublishPlatformVideoService] publish failed')
      await this.publishedVideoRepository.markFailed(video.organizationId, video.id)
      await this.deleteBinaryIfAllPlatformsResolved.execute(video.sourceUploadId)
      await this.reconcileBulkUploadStatus.execute(sourceUpload.bulkUploadId)
      const notification = await this.notificationRepository.create({
        organizationId: video.organizationId,
        type: NotificationType.VideoUploadFailed,
        data: { sourceId: video.sourceId, seriesId: video.seriesId, platform: video.platform, failReason: reason },
      })
      this.notificationPublisher.publish(notification)
      return false
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
}
