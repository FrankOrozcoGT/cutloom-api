import { eq } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { planFeatures, plans } from '../db/schema'
import { Plan } from '../../domain/entities/Plan'
import { PlanFeature } from '../../domain/entities/PlanFeature'
import type { PlanRepository } from '../../domain/ports/PlanRepository'

function toEntity(row: typeof plans.$inferSelect): Plan {
  return Plan.create({
    id: row.id,
    name: row.name,
    recurrentePriceId: row.recurrentePriceId,
    amountInCents: row.amountInCents,
    currency: row.currency,
    interval: row.interval,
  })
}

function toFeatureEntity(row: typeof planFeatures.$inferSelect): PlanFeature {
  return PlanFeature.create({
    id: row.id,
    planId: row.planId,
    feature: row.feature,
    usageLimit: row.usageLimit,
  })
}

export class DrizzlePlanRepository implements PlanRepository {
  constructor(private readonly db: Database) {}

  async findAll(): Promise<Plan[]> {
    const rows = await this.db.select().from(plans)
    return rows.map(toEntity)
  }

  async findById(id: string): Promise<Plan | null> {
    const [row] = await this.db.select().from(plans).where(eq(plans.id, id)).limit(1)
    return row ? toEntity(row) : null
  }

  async findFeaturesByPlanId(planId: string): Promise<PlanFeature[]> {
    const rows = await this.db.select().from(planFeatures).where(eq(planFeatures.planId, planId))
    return rows.map(toFeatureEntity)
  }
}
