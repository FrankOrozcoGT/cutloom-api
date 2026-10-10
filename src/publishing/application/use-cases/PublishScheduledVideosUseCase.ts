import type { VideoPlatform } from '../../domain/entities/PublishedVideo'
import type { PublishedVideoRepository } from '../../domain/ports/PublishedVideoRepository'
import type { SourceUploadRepository } from '../../domain/ports/SourceUploadRepository'
import type { SourceUploadBinaryReader } from '../../domain/ports/SourceUploadBinaryReader'
import type { PlatformCredentialResolver } from '../../domain/ports/PlatformCredentialResolver'
import type { VideoUploader } from '../../domain/ports/VideoUploader'
import type { ContentRevisionRepository } from '../../domain/ports/ContentRevisionRepository'
import type { NotificationRepository } from '../../../shared/domain/ports/NotificationRepository'
import type { NotificationPublisher } from '../../../shared/domain/ports/NotificationPublisher'
import { NotificationType } from '../../../shared/domain/entities/Notification'
import type { DeleteBinaryIfAllPlatformsResolvedService } from '../services/DeleteBinaryIfAllPlatformsResolvedService'
import type { ReconcileBulkUploadStatusService } from '../services/ReconcileBulkUploadStatusService'
import type { Logger } from '../../../shared/domain/ports/Logger'

const TIKTOK_STUDIO_URL = 'https://www.tiktok.com/tiktokstudio/content'

/**
 * Cron de publicación diferida — único para cualquier plataforma sin scheduling nativo (hoy
 * solo TikTok la usa: su Content Posting API no soporta scheduling nativo ni cambiar
 * privacy_level después de publicar, mismo mecanismo que usan terceros como Buffer: "hold the
 * post locally and call the API at the scheduled time"). Se instancia una vez por plataforma
 * que lo necesite en el composition root; YouTube nunca deja filas Scheduled vencidas para
 * este caso de uso porque su scheduling es nativo (ver BulkUploadOrchestrator).
 *
 * Solo sube el binario y deja el registro en Publishing — no resuelve el resultado final acá,
 * ni hace ningún polling (ver TikTokContentPostingUploader). La resolución final (publicado o
 * falló) y su notificación llegan exclusivamente por webhook (ver HandleTikTokWebhookUseCase).
 *
 * La notificación de "borrador esperando en tu bandeja" SÍ se dispara acá, sin ninguna consulta
 * extra a TikTok: el adaptador (ver TikTokContentPostingUploader) ya sabe, en el momento real
 * del intento de subida, si terminó en inbox (uploadResult.pendingManualAction) — no hace
 * falta esperar ninguna confirmación asíncrona para ese aviso puntual.
 */
export class PublishScheduledVideosUseCase {
  constructor(
    private readonly platform: VideoPlatform,
    private readonly videoRepository: PublishedVideoRepository,
    private readonly sourceUploadRepository: SourceUploadRepository,
    private readonly binaryReader: SourceUploadBinaryReader,
    private readonly credentialResolver: PlatformCredentialResolver,
    private readonly uploader: VideoUploader,
    private readonly contentRevisionRepository: ContentRevisionRepository,
    private readonly notificationRepository: NotificationRepository,
    private readonly notificationPublisher: NotificationPublisher,
    private readonly deleteBinaryIfAllPlatformsResolved: DeleteBinaryIfAllPlatformsResolvedService,
    private readonly reconcileBulkUploadStatus: ReconcileBulkUploadStatusService,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<{ uploaded: number; failed: number }> {
    const due = await this.videoRepository.findDueScheduled(this.platform, new Date())
    let uploaded = 0
    let failed = 0

    for (const scheduledItem of due) {
      // Transición atómica scheduled -> publishing: si dos ejecuciones del cron corrieran
      // concurrentemente (o una anterior se solapara con la siguiente), solo una de las dos
      // gana esta fila — la otra recibe null y la salta sin publicar dos veces.
      const item = await this.videoRepository.claimScheduledForUpload(scheduledItem.organizationId, scheduledItem.id)
      if (!item) continue

      try {
        const accessToken = await this.credentialResolver.resolveAccessToken(item.platformAccountId)
        const [revision] = await this.contentRevisionRepository.findByIds(item.organizationId, [item.metadataRevisionId])
        if (!revision) throw new Error(`Content revision not found: ${item.metadataRevisionId}`)

        // sourceUploadId es el binario compartido entre cualquier plataforma que publique este
        // mismo sourceId (ver SourceUpload) — published_videos solo guarda la referencia, nunca
        // una copia del tusUploadId, para que las dos nunca puedan desincronizarse.
        const sourceUpload = await this.sourceUploadRepository.findById(item.sourceUploadId)
        if (!sourceUpload) throw new Error(`source_uploads row not found: ${item.sourceUploadId}`)
        const videoSize = await this.binaryReader.size(sourceUpload.tusUploadId)
        const videoStream = await this.binaryReader.open(sourceUpload.tusUploadId)

        const result = await this.uploader.upload({
          accessToken,
          videoStream,
          videoSize,
          metadata: revision.metadata,
          publishAt: null,
          platformOptions: item.platformOptions,
        })

        // Persiste el publishId real — el webhook lo necesita para encontrar este registro
        // (ver PublishedVideoRepository.findByPublishId). El binario NO se borra acá: el
        // resultado todavía es incierto, se borra recién cuando el webhook confirma éxito.
        await this.videoRepository.markUploaded(item.organizationId, item.id, result.platformVideoId, result.status, result.publishId)
        uploaded++

        if (result.pendingManualAction) {
          const notification = await this.notificationRepository.create({
            organizationId: item.organizationId,
            type: NotificationType.TikTokDraftReady,
            data: { sourceId: item.sourceId, seriesId: item.seriesId, tikTokInboxUrl: TIKTOK_STUDIO_URL },
          })
          this.notificationPublisher.publish(notification)
        }
      } catch (error) {
        this.logger.error(
          { sourceId: item.sourceId, platform: this.platform, error: error instanceof Error ? error.message : error },
          '[PublishScheduledVideosUseCase] upload failed',
        )
        await this.videoRepository.markFailed(item.organizationId, item.id)
        await this.deleteBinaryIfAllPlatformsResolved.execute(item.sourceUploadId)
        const sourceUpload = await this.sourceUploadRepository.findById(item.sourceUploadId)
        if (sourceUpload) await this.reconcileBulkUploadStatus.execute(sourceUpload.bulkUploadId)
        failed++
      }
    }

    return { uploaded, failed }
  }
}
