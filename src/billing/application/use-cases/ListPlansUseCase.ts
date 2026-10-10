import type { PlanRepository } from '../../domain/ports/PlanRepository'
import type { SubscriptionInterval } from '../../domain/entities/Plan'
import type { Feature } from '../../../shared/domain/entities/Feature'

export interface PlanSummary {
  id: string
  name: string
  amountInCents: number
  currency: string
  interval: SubscriptionInterval
  creditsPerCycle: number
  features: Feature[]
}

/** Listado público de planes (pricing page) — sin auth, no expone recurrentePriceId (detalle interno de la pasarela). */
export class ListPlansUseCase {
  constructor(private readonly planRepository: PlanRepository) {}

  async execute(): Promise<PlanSummary[]> {
    const plans = await this.planRepository.findAll()
    const featuresByPlanId = await this.planRepository.findFeaturesByPlanIds(plans.map((p) => p.id))

    return plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      amountInCents: plan.amountInCents,
      currency: plan.currency,
      interval: plan.interval,
      creditsPerCycle: plan.creditsPerCycle,
      features: (featuresByPlanId.get(plan.id) ?? []).map((f) => f.feature),
    }))
  }
}
