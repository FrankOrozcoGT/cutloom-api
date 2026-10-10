import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { activePlatformAccounts } from '../db/schema'
import type { VideoPlatform } from '../../domain/entities/PublishedVideo'
import type { ActivePlatformAccountRepository } from '../../domain/ports/ActivePlatformAccountRepository'

export class DrizzleActivePlatformAccountRepository implements ActivePlatformAccountRepository {
  constructor(private readonly db: Database) {}

  async findActivePlatformAccountId(organizationId: string, platform: VideoPlatform): Promise<string | null> {
    const [row] = await this.db
      .select({ platformAccountId: activePlatformAccounts.platformAccountId })
      .from(activePlatformAccounts)
      .where(and(eq(activePlatformAccounts.organizationId, organizationId), eq(activePlatformAccounts.platform, platform)))
      .limit(1)
    return row?.platformAccountId ?? null
  }

  async setActivePlatformAccount(organizationId: string, platform: VideoPlatform, platformAccountId: string): Promise<void> {
    await this.db
      .insert(activePlatformAccounts)
      .values({ organizationId, platform, platformAccountId })
      .onConflictDoUpdate({
        target: [activePlatformAccounts.organizationId, activePlatformAccounts.platform],
        set: { platformAccountId, updatedAt: new Date() },
      })
  }
}
