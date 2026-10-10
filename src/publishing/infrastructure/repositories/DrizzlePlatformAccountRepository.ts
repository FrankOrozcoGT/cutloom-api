import { eq } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { platformAccounts } from '../db/schema'
import { PlatformAccount } from '../../domain/entities/PlatformAccount'
import type { FindOrCreatePlatformAccountInput, PlatformAccountRepository } from '../../domain/ports/PlatformAccountRepository'

function toEntity(row: typeof platformAccounts.$inferSelect): PlatformAccount {
  return PlatformAccount.create({
    id: row.id,
    organizationId: row.organizationId,
    platform: row.platform,
    externalAccountId: row.externalAccountId,
    platformAccountInfo: row.platformAccountInfo as Record<string, unknown> | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

export class DrizzlePlatformAccountRepository implements PlatformAccountRepository {
  constructor(private readonly db: Database) {}

  async findOrCreate(input: FindOrCreatePlatformAccountInput): Promise<PlatformAccount> {
    const [row] = await this.db
      .insert(platformAccounts)
      .values({
        organizationId: input.organizationId,
        platform: input.platform,
        externalAccountId: input.externalAccountId,
        platformAccountInfo: input.platformAccountInfo,
      })
      .onConflictDoUpdate({
        target: [platformAccounts.organizationId, platformAccounts.platform, platformAccounts.externalAccountId],
        set: {
          platformAccountInfo: input.platformAccountInfo,
          updatedAt: new Date(),
        },
      })
      .returning()

    if (!row) {
      throw new Error(
        `Failed to find or create platform account for organization ${input.organizationId} / platform ${input.platform}`,
      )
    }
    return toEntity(row)
  }

  async findById(id: string): Promise<PlatformAccount | null> {
    const [row] = await this.db.select().from(platformAccounts).where(eq(platformAccounts.id, id)).limit(1)
    return row ? toEntity(row) : null
  }
}
