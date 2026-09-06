import type { Plan } from '../entities/Plan'
import type { PlanFeature } from '../entities/PlanFeature'

export interface PlanRepository {
  findAll(): Promise<Plan[]>
  findById(id: string): Promise<Plan | null>
  findFeaturesByPlanId(planId: string): Promise<PlanFeature[]>
  /** Caso bulk de findFeaturesByPlanId: resuelve las features de varios planes en una sola query. */
  findFeaturesByPlanIds(planIds: string[]): Promise<Map<string, PlanFeature[]>>
}
