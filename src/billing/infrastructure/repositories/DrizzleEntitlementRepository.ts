import { and, eq, lt, sql } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { entitlements, planFeatures, subscriptions } from '../db/schema'
import { Entitlement } from '../../domain/entities/Entitlement'
import { UsageLimitExceededError } from '../../domain/ports/EntitlementRepository'
import type { AuthorizationContext, EntitlementRepository } from '../../domain/ports/EntitlementRepository'

function toEntity(row: typeof entitlements.$inferSelect): Entitlement {
  return Entitlement.create({
    id: row.id,
    organizationId: row.organizationId,
    feature: row.feature,
    active: row.active,
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

  async findAuthorizationContext(organizationId: string, feature: string): Promise<AuthorizationContext> {
    const [row] = await this.db
      .select({
        entitlement: entitlements,
        usageLimit: planFeatures.usageLimit,
      })
      .from(entitlements)
      .leftJoin(subscriptions, eq(subscriptions.organizationId, entitlements.organizationId))
      .leftJoin(
        planFeatures,
        and(eq(planFeatures.planId, subscriptions.planId), eq(planFeatures.feature, entitlements.feature)),
      )
      .where(and(eq(entitlements.organizationId, organizationId), eq(entitlements.feature, feature)))
      .limit(1)

    return {
      entitlement: row ? toEntity(row.entitlement) : null,
      currentUsageLimit: row?.usageLimit ?? null,
    }
  }

  async setActive(organizationId: string, feature: string, active: boolean): Promise<void> {
    if (!active) {
      return this.deactivateAll(organizationId, [feature])
    }
    await this.db
      .insert(entitlements)
      .values({ organizationId, feature, active })
      .onConflictDoUpdate({
        target: [entitlements.organizationId, entitlements.feature],
        set: { active, updatedAt: new Date() },
      })
  }

  async grant(organizationId: string, feature: string): Promise<void> {
    return this.grantAll(organizationId, [feature])
  }

  async grantAll(organizationId: string, features: string[]): Promise<void> {
    if (features.length === 0) return
    await this.db
      .insert(entitlements)
      .values(features.map((feature) => ({ organizationId, feature, active: true, usageCount: 0 })))
      .onConflictDoUpdate({
        target: [entitlements.organizationId, entitlements.feature],
        set: { active: true, usageCount: 0, updatedAt: new Date() },
      })
  }

  async deactivateAll(organizationId: string, features: string[]): Promise<void> {
    if (features.length === 0) return
    await this.db
      .insert(entitlements)
      .values(features.map((feature) => ({ organizationId, feature, active: false })))
      .onConflictDoUpdate({
        target: [entitlements.organizationId, entitlements.feature],
        set: { active: false, updatedAt: new Date() },
      })
  }

  async incrementUsage(organizationId: string, feature: string, currentUsageLimit: number | null): Promise<void> {
    if (currentUsageLimit === null) {
      return
    }

    await this.db.transaction(async (tx) => {
      // El chequeo del tope vive en el propio WHERE del UPDATE (atómico a nivel de fila en
      // Postgres) en vez de un SELECT previo — un SELECT-luego-UPDATE separado deja una
      // ventana de carrera donde dos requests concurrentes leen el mismo usageCount antes
      // de que ninguno haga commit, permitiendo que ambos pasen el chequeo y excedan el tope.
      const [updated] = await tx
        .update(entitlements)
        .set({ usageCount: sql`${entitlements.usageCount} + 1`, updatedAt: new Date() })
        .where(
          and(
            eq(entitlements.organizationId, organizationId),
            eq(entitlements.feature, feature),
            lt(entitlements.usageCount, currentUsageLimit),
          ),
        )
        .returning({ id: entitlements.id })

      if (!updated) {
        throw new UsageLimitExceededError(organizationId, feature)
      }
    })
  }
}
