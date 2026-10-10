import type { BulkUploadRepository } from '../../domain/ports/BulkUploadRepository'
import type { CancelBulkUploadService } from '../services/CancelBulkUploadService'

// Mismo plazo que R2 usa por default para abortar multipart uploads incompletos (ver
// TusS3SourceUploadBinaryReader) — un bulk sin NINGUNA actividad (en NINGUNO de sus archivos)
// en 7 días se da por abandonado como un todo, nunca parcialmente. Actividad en cualquier
// archivo reinicia lastActivityAt del bulk completo (ver BulkUploadOrchestrator.onSourceUploadActivity).
const STALE_BULK_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Cron diario — un bulk sin actividad en 7 días se cancela automáticamente (ver
 * CancelBulkUploadService para el mecanismo real). El usuario tiene que volver a subir el bulk
 * completo desde cero (un seriesId expirado permite un bulk nuevo, ver
 * bulk_uploads_active_series_id_idx) — distinto de la cancelación explícita a pedido
 * (CancelBulkUploadUseCase), que el frontend dispara cuando decide, no el backend por su cuenta.
 */
export class ExpireStaleBulkUploadsUseCase {
  constructor(
    private readonly bulkUploadRepository: BulkUploadRepository,
    private readonly cancelBulkUploadService: CancelBulkUploadService,
  ) {}

  async execute(): Promise<number> {
    const olderThan = new Date(Date.now() - STALE_BULK_THRESHOLD_MS)
    const staleBulks = await this.bulkUploadRepository.findStaleActive(olderThan)

    for (const bulk of staleBulks) {
      await this.cancelBulkUploadService.cancel(bulk)
    }

    return staleBulks.length
  }
}
