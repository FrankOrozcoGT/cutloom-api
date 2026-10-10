import { PublishedVideoStatus } from '../../domain/entities/PublishedVideo'
import type { PublishedVideoRepository } from '../../domain/ports/PublishedVideoRepository'
import type { PlatformOAuthTokenRepository } from '../../domain/ports/PlatformOAuthTokenRepository'
import type { TokenEncryptionService } from '../../domain/ports/TokenEncryptionService'
import type { SourceUploadRepository } from '../../domain/ports/SourceUploadRepository'
import type { NotificationRepository } from '../../../shared/domain/ports/NotificationRepository'
import type { NotificationPublisher } from '../../../shared/domain/ports/NotificationPublisher'
import { NotificationType } from '../../../shared/domain/entities/Notification'
import type { DeleteBinaryIfAllPlatformsResolvedService } from '../services/DeleteBinaryIfAllPlatformsResolvedService'
import type { ReconcileBulkUploadStatusService } from '../services/ReconcileBulkUploadStatusService'
import {
  fetchTikTokPostStatus,
  TIKTOK_WEBHOOK_EVENT_PUBLISH_COMPLETE,
  TIKTOK_WEBHOOK_EVENT_PUBLISH_FAILED,
} from '../../infrastructure/providers/TikTokContentPostingUploader'

export interface TikTokWebhookInput {
  event: string
  publishId: string
}

/**
 * Único punto de resolución async para TikTok — sin polling (ver TikTokContentPostingUploader):
 * el video queda Publishing hasta que este caso de uso lo actualiza, disparado por
 * post.publish.complete / post.publish.failed. El evento no trae fail_reason ni el id público
 * del video (solo publish_id) — se hace una única llamada puntual a status/fetch acá, nunca en
 * loop, para completar ese detalle.
 */
export class HandleTikTokWebhookUseCase {
  constructor(
    private readonly videoRepository: PublishedVideoRepository,
    private readonly oauthTokenRepository: PlatformOAuthTokenRepository,
    private readonly encryptionService: TokenEncryptionService,
    private readonly deleteBinaryIfAllPlatformsResolved: DeleteBinaryIfAllPlatformsResolvedService,
    private readonly reconcileBulkUploadStatus: ReconcileBulkUploadStatusService,
    private readonly sourceUploadRepository: SourceUploadRepository,
    private readonly notificationRepository: NotificationRepository,
    private readonly notificationPublisher: NotificationPublisher,
  ) {}

  async execute(input: TikTokWebhookInput): Promise<void> {
    if (input.event !== TIKTOK_WEBHOOK_EVENT_PUBLISH_COMPLETE && input.event !== TIKTOK_WEBHOOK_EVENT_PUBLISH_FAILED) {
      // Evento reconocido por TikTok pero fuera de los dos que nos interesan (ej. futuros
      // eventos de photo post) — se ignora explícitamente, no es un error de nuestro sistema.
      return
    }

    const item = await this.videoRepository.findByPublishId(input.publishId)
    if (!item) return // webhook de un publishId que no es nuestro (otra app, o ya reconciliado) — nada que hacer.
    if (item.status !== PublishedVideoStatus.Publishing) return // ya resuelto (reintento de TikTok) — idempotente.

    const token = await this.oauthTokenRepository.findByPlatformAccountId(item.platformAccountId)
    if (!token) {
      await this.videoRepository.markFailed(item.organizationId, item.id)
      await this.deleteBinaryIfAllPlatformsResolved.execute(item.sourceUploadId)
      await this.reconcileBulkUpload(item.sourceUploadId)
      return
    }
    const accessToken = this.encryptionService.decrypt(token.encryptedAccessToken)
    const detail = await fetchTikTokPostStatus(accessToken, input.publishId)

    if (input.event === TIKTOK_WEBHOOK_EVENT_PUBLISH_FAILED || detail.status === 'FAILED') {
      await this.videoRepository.markFailed(item.organizationId, item.id)
      await this.deleteBinaryIfAllPlatformsResolved.execute(item.sourceUploadId)
      await this.reconcileBulkUpload(item.sourceUploadId)
      const notification = await this.notificationRepository.create({
        organizationId: item.organizationId,
        type: NotificationType.VideoUploadFailed,
        data: { sourceId: item.sourceId, seriesId: item.seriesId, platform: 'tiktok', failReason: detail.failReason },
      })
      this.notificationPublisher.publish(notification)
      return
    }

    // post.publish.complete: se dispara tanto cuando el video quedó público de inmediato
    // (DIRECT_POST aprobado) como cuando el usuario terminó de publicar manualmente un
    // borrador que antes quedó en su bandeja (MEDIA_UPLOAD) — en ambos casos el resultado ya
    // es Uploaded, la única diferencia es si tenemos o no el id público.
    const platformVideoId = detail.publiclyAvailablePostIds[0] ?? null
    await this.videoRepository.markUploaded(item.organizationId, item.id, platformVideoId, PublishedVideoStatus.Uploaded, input.publishId)
    await this.deleteBinaryIfAllPlatformsResolved.execute(item.sourceUploadId)
    await this.reconcileBulkUpload(item.sourceUploadId)

    const notification = await this.notificationRepository.create({
      organizationId: item.organizationId,
      type: NotificationType.VideoPublished,
      data: {
        sourceId: item.sourceId,
        seriesId: item.seriesId,
        platform: 'tiktok',
        videoUrl: platformVideoId ? `https://www.tiktok.com/tiktokstudio/upload/post/${platformVideoId}` : null,
      },
    })
    this.notificationPublisher.publish(notification)
  }

  private async reconcileBulkUpload(sourceUploadId: string): Promise<void> {
    const sourceUpload = await this.sourceUploadRepository.findById(sourceUploadId)
    if (!sourceUpload) return
    await this.reconcileBulkUploadStatus.execute(sourceUpload.bulkUploadId)
  }
}
