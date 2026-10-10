import type { BulkUploadStatus } from '../../domain/entities/BulkUpload'
import type { SourceUploadStatus } from '../../domain/entities/SourceUpload'
import type { PublishedVideoStatus, VideoPlatform } from '../../domain/entities/PublishedVideo'
import type { BulkUploadRepository } from '../../domain/ports/BulkUploadRepository'
import type { SourceUploadRepository } from '../../domain/ports/SourceUploadRepository'
import type { PublishedVideoRepository } from '../../domain/ports/PublishedVideoRepository'
import { BulkUploadNotFoundError } from './CancelBulkUploadUseCase'

export interface BulkUploadItemPlatformStatus {
  platform: VideoPlatform
  status: PublishedVideoStatus
}

export interface BulkUploadItemStatus {
  sourceId: string
  uploadStatus: SourceUploadStatus
  platforms: BulkUploadItemPlatformStatus[]
}

export interface BulkUploadStatusOutput {
  bulkUploadId: string
  status: BulkUploadStatus
  items: BulkUploadItemStatus[]
}

/**
 * Expone el estado real de un bulk (activo/completo/expirado) y de cada uno de sus archivos —
 * el frontend lo usa para decidir, con datos reales en vez de inferir de un error, si debe
 * ofrecerle al usuario "continuar" (reenviar el mismo plan a planBulkUpload, resume lo que
 * falte) o "empezar de nuevo" (cancelar explícito vía CancelBulkUploadUseCase, después plan
 * limpio). El backend nunca decide cuál de las dos opciones es la correcta — solo informa.
 */
export class GetBulkUploadStatusUseCase {
  constructor(
    private readonly bulkUploadRepository: BulkUploadRepository,
    private readonly sourceUploadRepository: SourceUploadRepository,
    private readonly publishedVideoRepository: PublishedVideoRepository,
  ) {}

  async execute(organizationId: string, seriesId: string): Promise<BulkUploadStatusOutput> {
    const bulk = await this.bulkUploadRepository.findMostRecentBySeriesId(seriesId)
    if (!bulk || bulk.organizationId !== organizationId) {
      throw new BulkUploadNotFoundError(seriesId)
    }

    const sourceUploads = await this.sourceUploadRepository.findByBulkUploadId(bulk.id)
    const items: BulkUploadItemStatus[] = []
    for (const sourceUpload of sourceUploads) {
      const videos = await this.publishedVideoRepository.findBySourceUploadId(sourceUpload.id)
      items.push({
        sourceId: sourceUpload.sourceId,
        uploadStatus: sourceUpload.status,
        platforms: videos.map((video) => ({ platform: video.platform, status: video.status })),
      })
    }

    return { bulkUploadId: bulk.id, status: bulk.status, items }
  }
}
