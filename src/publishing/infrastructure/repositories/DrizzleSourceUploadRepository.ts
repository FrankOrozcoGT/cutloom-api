import { and, eq, ne } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { sourceUploads } from '../db/schema'
import { SourceUpload, SourceUploadStatus } from '../../domain/entities/SourceUpload'
import type { CreateSourceUploadInput, SourceUploadRepository } from '../../domain/ports/SourceUploadRepository'

function toEntity(row: typeof sourceUploads.$inferSelect): SourceUpload {
  return SourceUpload.create({
    id: row.id,
    bulkUploadId: row.bulkUploadId,
    sourceId: row.sourceId,
    tusUploadId: row.tusUploadId,
    status: row.status,
    videoSizeBytes: row.videoSizeBytes,
    createdAt: row.createdAt,
  })
}

export class DrizzleSourceUploadRepository implements SourceUploadRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateSourceUploadInput): Promise<SourceUpload> {
    const [row] = await this.db
      .insert(sourceUploads)
      .values({
        bulkUploadId: input.bulkUploadId,
        sourceId: input.sourceId,
        tusUploadId: input.tusUploadId,
        videoSizeBytes: input.videoSizeBytes,
        status: SourceUploadStatus.Uploading,
      })
      .returning()
    if (!row) throw new Error(`Failed to create source upload for sourceId ${input.sourceId}`)
    return toEntity(row)
  }

  async findById(id: string): Promise<SourceUpload | null> {
    const [row] = await this.db.select().from(sourceUploads).where(eq(sourceUploads.id, id)).limit(1)
    return row ? toEntity(row) : null
  }

  async findByTusUploadId(tusUploadId: string): Promise<SourceUpload | null> {
    const [row] = await this.db.select().from(sourceUploads).where(eq(sourceUploads.tusUploadId, tusUploadId)).limit(1)
    return row ? toEntity(row) : null
  }

  async findByBulkUploadIdAndSourceId(bulkUploadId: string, sourceId: string): Promise<SourceUpload | null> {
    const [row] = await this.db
      .select()
      .from(sourceUploads)
      .where(and(eq(sourceUploads.bulkUploadId, bulkUploadId), eq(sourceUploads.sourceId, sourceId)))
      .limit(1)
    return row ? toEntity(row) : null
  }

  async findByBulkUploadId(bulkUploadId: string): Promise<SourceUpload[]> {
    const rows = await this.db.select().from(sourceUploads).where(eq(sourceUploads.bulkUploadId, bulkUploadId))
    return rows.map(toEntity)
  }

  async markCompleted(id: string): Promise<SourceUpload> {
    const [row] = await this.db
      .update(sourceUploads)
      .set({ status: SourceUploadStatus.Completed })
      .where(eq(sourceUploads.id, id))
      .returning()
    if (!row) throw new Error(`source_uploads row not found: ${id}`)
    return toEntity(row)
  }

  async allCompletedForBulkUpload(bulkUploadId: string): Promise<boolean> {
    const [pending] = await this.db
      .select({ id: sourceUploads.id })
      .from(sourceUploads)
      .where(and(eq(sourceUploads.bulkUploadId, bulkUploadId), ne(sourceUploads.status, SourceUploadStatus.Completed)))
      .limit(1)
    return pending === undefined
  }
}
