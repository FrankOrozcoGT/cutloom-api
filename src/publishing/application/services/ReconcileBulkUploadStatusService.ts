import { PublishedVideoStatus } from '../../domain/entities/PublishedVideo'
import type { BulkUploadRepository } from '../../domain/ports/BulkUploadRepository'
import type { SourceUploadRepository } from '../../domain/ports/SourceUploadRepository'
import type { PublishedVideoRepository } from '../../domain/ports/PublishedVideoRepository'

const PENDING_STATUSES: readonly string[] = [
  PublishedVideoStatus.AwaitingUpload,
  PublishedVideoStatus.Publishing,
  PublishedVideoStatus.Scheduled,
]

export class ReconcileBulkUploadStatusService {
  constructor(
    private readonly bulkUploadRepository: BulkUploadRepository,
    private readonly sourceUploadRepository: SourceUploadRepository,
    private readonly publishedVideoRepository: PublishedVideoRepository,
  ) {}

  async execute(bulkUploadId: string): Promise<void> {
    const sourceUploads = await this.sourceUploadRepository.findByBulkUploadId(bulkUploadId)
    const allVideos = []
    for (const sourceUpload of sourceUploads) {
      allVideos.push(...(await this.publishedVideoRepository.findBySourceUploadId(sourceUpload.id)))
    }

    const anyPending = allVideos.some((video) => PENDING_STATUSES.includes(video.status))
    if (anyPending) return

    const anyFailed = allVideos.some((video) => video.status === PublishedVideoStatus.Failed)
    await this.bulkUploadRepository.markPublishingResolved(bulkUploadId, !anyFailed)
  }
}
