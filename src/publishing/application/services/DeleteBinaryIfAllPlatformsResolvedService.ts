import { PublishedVideoStatus } from '../../domain/entities/PublishedVideo'
import type { SourceUploadRepository } from '../../domain/ports/SourceUploadRepository'
import type { SourceUploadBinaryReader } from '../../domain/ports/SourceUploadBinaryReader'
import type { PublishedVideoRepository } from '../../domain/ports/PublishedVideoRepository'

const TERMINAL_STATUSES: readonly string[] = [
  PublishedVideoStatus.Uploaded,
  PublishedVideoStatus.Inbox,
  PublishedVideoStatus.Failed,
]

export class DeleteBinaryIfAllPlatformsResolvedService {
  constructor(
    private readonly publishedVideoRepository: PublishedVideoRepository,
    private readonly sourceUploadRepository: SourceUploadRepository,
    private readonly binaryReader: SourceUploadBinaryReader,
  ) {}

  async execute(sourceUploadId: string): Promise<void> {
    const rows = await this.publishedVideoRepository.findBySourceUploadId(sourceUploadId)
    const allResolved = rows.every((row) => TERMINAL_STATUSES.includes(row.status))
    if (!allResolved) return

    const sourceUpload = await this.sourceUploadRepository.findById(sourceUploadId)
    if (!sourceUpload) return
    await this.binaryReader.delete(sourceUpload.tusUploadId)
  }
}
