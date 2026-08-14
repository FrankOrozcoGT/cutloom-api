import { eq } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { tokenBlacklist } from '../db/schema'
import type { TokenBlacklistRepository } from '../../domain/ports/TokenBlacklistRepository'

export class DrizzleTokenBlacklistRepository implements TokenBlacklistRepository {
  constructor(private readonly db: Database) {}

  async add(token: string, expiresAt: Date): Promise<void> {
    await this.db.insert(tokenBlacklist).values({ token, expiresAt }).onConflictDoNothing()
  }

  async isBlacklisted(token: string): Promise<boolean> {
    const [row] = await this.db.select().from(tokenBlacklist).where(eq(tokenBlacklist.token, token)).limit(1)
    return row !== undefined
  }
}
