import type { BulkUploadRepository } from '../../domain/ports/BulkUploadRepository'
import type { BulkUploadOrchestrator } from './BulkUploadOrchestrator'

export class BulkUploadNotFoundByIdError extends Error {
  constructor(bulkUploadId: string) {
    super(`No bulk upload found with id: ${bulkUploadId}`)
    this.name = 'BulkUploadNotFoundByIdError'
  }
}

export class RetryFailedPublicationsUseCase {
  constructor(
    private readonly bulkUploadRepository: BulkUploadRepository,
    private readonly bulkUploadOrchestrator: BulkUploadOrchestrator,
  ) {}

  async execute(organizationId: string, bulkUploadId: string): Promise<void> {
    const bulk = await this.bulkUploadRepository.findById(bulkUploadId)
    if (!bulk || bulk.organizationId !== organizationId) {
      throw new BulkUploadNotFoundByIdError(bulkUploadId)
    }
    await this.bulkUploadOrchestrator.retryFailed(bulkUploadId)
  }
}
