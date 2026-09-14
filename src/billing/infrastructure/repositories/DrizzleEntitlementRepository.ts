import { and, eq, lt, sql } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { entitlements, planFeatures, subscriptions } from '../db/schema'
import { UsageLimitExceededError } from '../../domain/ports/EntitlementRepository'
import type {
  AuthorizationContext,
  EntitlementRepository,
  FeatureAccess,
} from '../../domain/ports/EntitlementRepository'

export class DrizzleEntitlementRepository implements EntitlementRepository {
  constructor(private readonly db: Database) {}

  async findActiveFeaturesByOrganizationId(organizationId: string): Promise<FeatureAccess[]> {
    const rows = await this.db
      .select({ feature: planFeatures.feature, usageLimit: planFeatures.usageLimit })
      .from(subscriptions)
      .innerJoin(planFeatures, eq(planFeatures.planId, subscriptions.planId))
      .where(and(eq(subscriptions.organizationId, organizationId), eq(subscriptions.status, 'active')))
    return rows
  }

  async findAuthorizationContext(organizationId: string, feature: string): Promise<AuthorizationContext> {
    const [row] = await this.db
      .select({
        usageLimit: planFeatures.usageLimit,
        usageCount: entitlements.usageCount,
      })
      .from(subscriptions)
      .innerJoin(
        planFeatures,
        and(eq(planFeatures.planId, subscriptions.planId), eq(planFeatures.feature, feature)),
      )
      .leftJoin(
        entitlements,
        and(eq(entitlements.organizationId, subscriptions.organizationId), eq(entitlements.feature, feature)),
      )
      .where(and(eq(subscriptions.organizationId, organizationId), eq(subscriptions.status, 'active')))
      .limit(1)

    return {
      active: row !== undefined,
      usageCount: row?.usageCount ?? 0,
      currentUsageLimit: row?.usageLimit ?? null,
    }
  }

  async resetUsage(organizationId: string, feature: string): Promise<void> {
    return this.resetUsageForFeatures(organizationId, [feature])
  }

  async resetUsageForFeatures(organizationId: string, features: string[]): Promise<void> {
    if (features.length === 0) return
    await this.db
      .insert(entitlements)
      .values(features.map((feature) => ({ organizationId, feature, usageCount: 0 })))
      .onConflictDoUpdate({
        target: [entitlements.organizationId, entitlements.feature],
        set: { usageCount: 0, updatedAt: new Date() },
      })
  }

  async incrementUsage(
    organizationId: string,
    feature: string,
    amount: number,
    currentUsageLimit: number | null,
  ): Promise<void> {
    if (currentUsageLimit === null) {
      return
    }
    // Cubre el caso de la primera fila (INSERT sin conflicto, donde setWhere no aplica):
    // si el propio amount ya excede el tope, ni siquiera vale la pena intentar el upsert.
    if (amount > currentUsageLimit) {
      throw new UsageLimitExceededError(organizationId, feature)
    }

    await this.db.transaction(async (tx) => {
      // Upsert atómico: la primera vez que se consume una feature con tope puede no existir
      // fila todavía en entitlements (nunca se llamó resetUsage para ella, ej. features
      // nuevas agregadas al catálogo de un plan ya activo) — se crea en 0 antes de sumar,
      // en el mismo statement, para no depender de un INSERT previo por evento de billing.
      // El chequeo del tope vive en el propio setWhere del upsert (atómico a nivel de fila
      // en Postgres) en vez de un SELECT previo — un SELECT-luego-UPDATE separado deja una
      // ventana de carrera donde dos requests concurrentes leen el mismo usageCount antes
      // de que ninguno haga commit, permitiendo que ambos pasen el chequeo y excedan el tope.
      const [updated] = await tx
        .insert(entitlements)
        .values({ organizationId, feature, usageCount: amount })
        .onConflictDoUpdate({
          target: [entitlements.organizationId, entitlements.feature],
          set: { usageCount: sql`${entitlements.usageCount} + ${amount}`, updatedAt: new Date() },
          setWhere: lt(entitlements.usageCount, currentUsageLimit - amount + 1),
        })
        .returning({ id: entitlements.id })

      if (!updated) {
        throw new UsageLimitExceededError(organizationId, feature)
      }
    })
  }
}
