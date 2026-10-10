import { PublishedVideoStatus } from '../../domain/entities/PublishedVideo'
import type { BulkUpload } from '../../domain/entities/BulkUpload'
import type { BulkUploadRepository } from '../../domain/ports/BulkUploadRepository'
import type { SourceUploadRepository } from '../../domain/ports/SourceUploadRepository'
import type { SourceUploadBinaryReader } from '../../domain/ports/SourceUploadBinaryReader'
import type { PublishedVideoRepository } from '../../domain/ports/PublishedVideoRepository'

/**
 * Cancela un bulk activo como un todo: aborta todos sus uploads tus pendientes en R2, marca
 * Failed todos sus published_videos que seguían AwaitingUpload, y el bulk pasa a Expired —
 * nunca una cancelación parcial por archivo. Usado tanto por el cron de expiración automática
 * (7 días sin actividad, ver ExpireStaleBulkUploadsUseCase) como por la cancelación explícita a
 * pedido del frontend (ver CancelBulkUploadUseCase) — misma operación, dos disparadores
 * distintos; el backend nunca decide por su cuenta cuándo cancelar salvo ese plazo fijo.
 */
export class CancelBulkUploadService {
  constructor(
    private readonly sourceUploadRepository: SourceUploadRepository,
    private readonly binaryReader: SourceUploadBinaryReader,
    private readonly publishedVideoRepository: PublishedVideoRepository,
    private readonly bulkUploadRepository: BulkUploadRepository,
  ) {}

  async cancel(bulk: BulkUpload): Promise<void> {
    const sourceUploads = await this.sourceUploadRepository.findByBulkUploadId(bulk.id)
    const allVideos = await this.publishedVideoRepository.findBySourceUploadIds(sourceUploads.map((sourceUpload) => sourceUpload.id))
    const videosBySourceUploadId = new Map<string, typeof allVideos>()
    for (const video of allVideos) {
      const list = videosBySourceUploadId.get(video.sourceUploadId) ?? []
      list.push(video)
      videosBySourceUploadId.set(video.sourceUploadId, list)
    }

    for (const sourceUpload of sourceUploads) {
      await this.binaryReader.delete(sourceUpload.tusUploadId)
      for (const video of videosBySourceUploadId.get(sourceUpload.id) ?? []) {
        if (video.status === PublishedVideoStatus.AwaitingUpload) {
          await this.publishedVideoRepository.markFailed(video.organizationId, video.id)
        }
      }
    }
    await this.bulkUploadRepository.markExpired(bulk.id)
  }
}
