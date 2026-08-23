import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { entitlements } from '../db/schema'
import { Entitlement } from '../../domain/entities/Entitlement'
import { UsageLimitExceededError } from '../../domain/ports/EntitlementRepository'
import type { EntitlementRepository } from '../../domain/ports/EntitlementRepository'

function toEntity(row: typeof entitlements.$inferSelect): Entitlement {
  return Entitlement.create({
    id: row.id,
    organizationId: row.organizationId,
    feature: row.feature,
    active: row.active,
    usageLimit: row.usageLimit,
    usageCount: row.usageCount,
  })
}

export class DrizzleEntitlementRepository implements EntitlementRepository {
  constructor(private readonly db: Database) {}

  async findByOrganizationAndFeature(organizationId: string, feature: string): Promise<Entitlement | null> {
    const [row] = await this.db
      .select()
      .from(entitlements)
      .where(and(eq(entitlements.organizationId, organizationId), eq(entitlements.feature, feature)))
      .limit(1)
    return row ? toEntity(row) : null
  }

  async findByOrganizationId(organizationId: string): Promise<Entitlement[]> {
    const rows = await this.db.select().from(entitlements).where(eq(entitlements.organizationId, organizationId))
    return rows.map(toEntity)
  }

  async setActive(organizationId: string, feature: string, active: boolean): Promise<void> {
    await this.db
      .insert(entitlements)
      .values({ organizationId, feature, active })
      .onConflictDoUpdate({
        target: [entitlements.organizationId, entitlements.feature],
        set: { active, updatedAt: new Date() },
      })
  }

  async grantWithUsageLimit(organizationId: string, feature: string, usageLimit: number | null): Promise<void> {
    await this.db
      .insert(entitlements)
      .values({ organizationId, feature, active: true, usageLimit, usageCount: 0 })
      .onConflictDoUpdate({
        target: [entitlements.organizationId, entitlements.feature],
        set: { active: true, usageLimit, usageCount: 0, updatedAt: new Date() },
      })
  }

  async incrementUsage(organizationId: string, feature: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(entitlements)
        .where(and(eq(entitlements.organizationId, organizationId), eq(entitlements.feature, feature)))
        .limit(1)

      if (!row || row.usageLimit === null) {
        return
      }

      if (row.usageCount >= row.usageLimit) {
        throw new UsageLimitExceededError(organizationId, feature)
      }

      await tx
        .update(entitlements)
        .set({ usageCount: sql`${entitlements.usageCount} + 1`, updatedAt: new Date() })
        .where(and(eq(entitlements.organizationId, organizationId), eq(entitlements.feature, feature)))
    })
  }
}
