import type { VideoPlatform } from '../../domain/entities/PublishedVideo'
import type { PublishedVideoRepository } from '../../domain/ports/PublishedVideoRepository'
import type { PublishPlatformVideoService } from '../services/PublishPlatformVideoService'

/**
 * Cron de publicación diferida — único para cualquier plataforma sin scheduling nativo (hoy
 * solo TikTok la usa: su Content Posting API no soporta scheduling nativo ni cambiar
 * privacy_level después de publicar, mismo mecanismo que usan terceros como Buffer: "hold the
 * post locally and call the API at the scheduled time"). Se instancia una vez por plataforma
 * que lo necesite en el composition root; YouTube nunca deja filas Scheduled vencidas para
 * este caso de uso porque su scheduling es nativo (ver BulkUploadOrchestrator).
 */
export class PublishScheduledVideosUseCase {
  constructor(
    private readonly platform: VideoPlatform,
    private readonly videoRepository: PublishedVideoRepository,
    private readonly publishPlatformVideo: PublishPlatformVideoService,
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

      // publishPlatformVideo.publish ya resuelve éxito/fallo, notificación, borrado del binario
      // y reconciliación del bulk — mismo mecanismo que BulkUploadOrchestrator. Solo TikTok
      // resuelve el resultado final por webhook (ver HandleTikTokWebhookUseCase); este cron
      // solo dispara el intento de subida, nunca lanza.
      const succeeded = await this.publishPlatformVideo.publish(item)
      if (succeeded) uploaded++
      else failed++
    }

    return { uploaded, failed }
  }
}
