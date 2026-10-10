import type { BulkUploadRepository } from '../../domain/ports/BulkUploadRepository'
import type { CancelBulkUploadService } from '../services/CancelBulkUploadService'

export class BulkUploadNotFoundError extends Error {
  constructor(seriesId: string) {
    super(`No active bulk upload found for seriesId: ${seriesId}`)
    this.name = 'BulkUploadNotFoundError'
  }
}

/**
 * Cancelación a pedido — el frontend es quien decide cuándo el usuario quiere abandonar un bulk
 * a medias y empezar de cero; el backend solo expone la operación y los estados reales (ver
 * GetBulkUploadStatusUseCase), nunca decide por su cuenta cancelar nada salvo el plazo fijo de
 * 7 días sin actividad (ExpireStaleBulkUploadsUseCase).
 */
export class CancelBulkUploadUseCase {
  constructor(
    private readonly bulkUploadRepository: BulkUploadRepository,
    private readonly cancelBulkUploadService: CancelBulkUploadService,
  ) {}

  async execute(organizationId: string, seriesId: string): Promise<void> {
    const bulk = await this.bulkUploadRepository.findActiveBySeriesId(seriesId)
    if (!bulk || bulk.organizationId !== organizationId) {
      throw new BulkUploadNotFoundError(seriesId)
    }
    await this.cancelBulkUploadService.cancel(bulk)
  }
}
