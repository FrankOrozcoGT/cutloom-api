import { and, eq, gte, isNull, or, sql } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { entitlements, planFeatures, subscriptions } from '../db/schema'
import { PlanBalanceExceededError } from '../../domain/ports/EntitlementRepository'
import type {
  AuthorizationContext,
  EntitlementRepository,
  FeatureAccess,
} from '../../domain/ports/EntitlementRepository'

export class DrizzleEntitlementRepository implements EntitlementRepository {
  constructor(private readonly db: Database) {}

  async findActiveFeaturesByOrganizationId(organizationId: string): Promise<FeatureAccess[]> {
    const rows = await this.db
      .select({
        feature: planFeatures.feature,
        usageLimit: planFeatures.usageLimit,
        planBalance: entitlements.balance,
      })
      .from(subscriptions)
      .innerJoin(planFeatures, eq(planFeatures.planId, subscriptions.planId))
      .leftJoin(
        entitlements,
        and(eq(entitlements.organizationId, subscriptions.organizationId), eq(entitlements.feature, planFeatures.feature)),
      )
      .where(and(eq(subscriptions.organizationId, organizationId), eq(subscriptions.status, 'active')))
    return rows
  }

  async findAuthorizationContext(organizationId: string, feature: string): Promise<AuthorizationContext> {
    const [row] = await this.db
      .select({ planBalance: entitlements.balance })
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
      planBalance: row?.planBalance ?? null,
    }
  }

  async chargeBalanceForFeatures(
    organizationId: string,
    features: { feature: string; usageLimit: number | null }[],
  ): Promise<void> {
    if (features.length === 0) return
    await this.db
      .insert(entitlements)
      .values(features.map(({ feature, usageLimit }) => ({ organizationId, feature, balance: usageLimit })))
      .onConflictDoUpdate({
        target: [entitlements.organizationId, entitlements.feature],
        // set no puede referenciar la fila entrante del VALUES por columna de otra fila
        // fácilmente en drizzle — como es un upsert con un solo row por (org,feature) a la
        // vez dentro del .map, cada statement del batch ya trae su propio excluded.balance.
        set: { balance: sql`excluded.balance`, updatedAt: new Date() },
      })
  }

  async deductFromPlanBalance(organizationId: string, feature: string, amount: number): Promise<void> {
    // feature sin tope (balance null): no se descuenta nada, el plan cubre ilimitado — distinto
    // de "balance en 0", que sí bloquea. El chequeo de saldo suficiente vive en el propio WHERE
    // del UPDATE (atómico a nivel de fila) para no dejar ventana de carrera entre un SELECT
    // previo y el UPDATE, igual que CreditAccountRepository.deductCredits.
    const [updated] = await this.db
      .update(entitlements)
      .set({ balance: sql`${entitlements.balance} - ${amount}`, updatedAt: new Date() })
      .where(
        and(
          eq(entitlements.organizationId, organizationId),
          eq(entitlements.feature, feature),
          or(isNull(entitlements.balance), gte(entitlements.balance, amount)),
        ),
      )
      .returning({ balance: entitlements.balance })

    if (!updated) {
      throw new PlanBalanceExceededError(organizationId, feature)
    }
  }
}
