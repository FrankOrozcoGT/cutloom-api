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
  findByBulkUploadId(bulkUploadId: string): Promise<SourceUpload[]>
  markCompleted(id: string): Promise<SourceUpload>
  /** true si TODOS los SourceUpload de este bulk están Completed — dispara la calendarización + publicación real (ver BulkUploadOrchestrator.onSourceUploadCompleted). */
  allCompletedForBulkUpload(bulkUploadId: string): Promise<boolean>
}
