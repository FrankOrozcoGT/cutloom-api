import { and, desc, eq, lt } from 'drizzle-orm'
import postgres from 'postgres'
import type { Database } from '../../../shared/infrastructure/db/client'
import { bulkUploads } from '../db/schema'
import { BulkUpload, BulkUploadStatus } from '../../domain/entities/BulkUpload'
import { BulkUploadAlreadyActiveError, type BulkUploadRepository } from '../../domain/ports/BulkUploadRepository'

const ACTIVE_SERIES_ID_CONSTRAINT = 'bulk_uploads_active_series_id_idx'

function isActiveSeriesIdViolation(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined
  return cause instanceof postgres.PostgresError && cause.code === '23505' && cause.constraint_name === ACTIVE_SERIES_ID_CONSTRAINT
}

function toEntity(row: typeof bulkUploads.$inferSelect): BulkUpload {
  return BulkUpload.create({
    id: row.id,
    organizationId: row.organizationId,
    seriesId: row.seriesId,
    timeZone: row.timeZone,
    longVideoPublishDay: row.longVideoPublishDay,
    status: row.status,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
  })
}

export class DrizzleBulkUploadRepository implements BulkUploadRepository {
  constructor(private readonly db: Database) {}

  async create(organizationId: string, seriesId: string, timeZone: string, longVideoPublishDay: Date): Promise<BulkUpload> {
    try {
      const [row] = await this.db
        .insert(bulkUploads)
        .values({ organizationId, seriesId, timeZone, longVideoPublishDay, status: BulkUploadStatus.Active })
        .returning()
      if (!row) throw new Error(`Failed to create bulk upload for seriesId ${seriesId}`)
      return toEntity(row)
    } catch (error) {
      if (isActiveSeriesIdViolation(error)) throw new BulkUploadAlreadyActiveError(seriesId)
      throw error
    }
  }

  async findById(id: string): Promise<BulkUpload | null> {
    const [row] = await this.db.select().from(bulkUploads).where(eq(bulkUploads.id, id)).limit(1)
    return row ? toEntity(row) : null
  }

  async findActiveBySeriesId(seriesId: string): Promise<BulkUpload | null> {
    const [row] = await this.db
      .select()
      .from(bulkUploads)
      .where(and(eq(bulkUploads.seriesId, seriesId), eq(bulkUploads.status, BulkUploadStatus.Active)))
      .limit(1)
    return row ? toEntity(row) : null
  }

  async findMostRecentBySeriesId(seriesId: string): Promise<BulkUpload | null> {
    const [row] = await this.db
      .select()
      .from(bulkUploads)
      .where(eq(bulkUploads.seriesId, seriesId))
      .orderBy(desc(bulkUploads.createdAt))
      .limit(1)
    return row ? toEntity(row) : null
  }

  async touchActivity(id: string, now: Date): Promise<void> {
    await this.db.update(bulkUploads).set({ lastActivityAt: now }).where(eq(bulkUploads.id, id))
  }

  async markUploaded(id: string): Promise<void> {
    await this.db.update(bulkUploads).set({ status: BulkUploadStatus.Uploaded }).where(eq(bulkUploads.id, id))
  }

  async markPublishing(id: string): Promise<void> {
    await this.db.update(bulkUploads).set({ status: BulkUploadStatus.Publishing }).where(eq(bulkUploads.id, id))
  }

  async markPublishingResolved(id: string, allSucceeded: boolean): Promise<void> {
    await this.db
      .update(bulkUploads)
      .set({ status: allSucceeded ? BulkUploadStatus.Completed : BulkUploadStatus.CompletedWithFailures })
      .where(eq(bulkUploads.id, id))
  }

  async findStaleActive(olderThan: Date): Promise<BulkUpload[]> {
    const rows = await this.db
      .select()
      .from(bulkUploads)
      .where(and(eq(bulkUploads.status, BulkUploadStatus.Active), lt(bulkUploads.lastActivityAt, olderThan)))
    return rows.map(toEntity)
  }

  async markExpired(id: string): Promise<void> {
    await this.db.update(bulkUploads).set({ status: BulkUploadStatus.Expired }).where(eq(bulkUploads.id, id))
  }
}
