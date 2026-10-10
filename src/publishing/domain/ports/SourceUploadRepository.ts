import type { SourceUpload } from '../entities/SourceUpload'

export interface CreateSourceUploadInput {
  bulkUploadId: string
  sourceId: string
  tusUploadId: string
  videoSizeBytes: number
}

export interface SourceUploadRepository {
  create(input: CreateSourceUploadInput): Promise<SourceUpload>
  findById(id: string): Promise<SourceUpload | null>
  findByTusUploadId(tusUploadId: string): Promise<SourceUpload | null>
  /** El único SourceUpload de este sourceId dentro de este bulk, si existe — para devolver la URL de upload ya existente en vez de crear un binario duplicado (ver planBulkUpload). */
  findByBulkUploadIdAndSourceId(bulkUploadId: string, sourceId: string): Promise<SourceUpload | null>
  findByBulkUploadId(bulkUploadId: string): Promise<SourceUpload[]>
  markCompleted(id: string): Promise<SourceUpload>
  /** true si TODOS los SourceUpload de este bulk están Completed — dispara la calendarización + publicación real (ver BulkUploadOrchestrator.onSourceUploadCompleted). */
  allCompletedForBulkUpload(bulkUploadId: string): Promise<boolean>
}
