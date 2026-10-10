import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { planFeatures, subscriptions } from '../db/schema'
import type { PlanFeatureAccessRepository } from '../../domain/ports/PlanFeatureAccessRepository'
import type { Feature } from '../../../shared/domain/entities/Feature'

export class DrizzlePlanFeatureAccessRepository implements PlanFeatureAccessRepository {
  constructor(private readonly db: Database) {}

  async findActiveFeaturesByOrganizationId(organizationId: string): Promise<Feature[]> {
    const rows = await this.db
      .select({ feature: planFeatures.feature })
      .from(subscriptions)
      .innerJoin(planFeatures, eq(planFeatures.planId, subscriptions.planId))
      .where(and(eq(subscriptions.organizationId, organizationId), eq(subscriptions.status, 'active')))
    return rows.map((row) => row.feature)
  }

  async isCoveredByActivePlan(organizationId: string, feature: Feature): Promise<boolean> {
    const [row] = await this.db
      .select({ feature: planFeatures.feature })
      .from(subscriptions)
      .innerJoin(planFeatures, and(eq(planFeatures.planId, subscriptions.planId), eq(planFeatures.feature, feature)))
      .where(and(eq(subscriptions.organizationId, organizationId), eq(subscriptions.status, 'active')))
      .limit(1)
    return row !== undefined
  }
}
