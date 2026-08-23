import type { Plan } from '../entities/Plan'
import type { PlanFeature } from '../entities/PlanFeature'

export interface PlanRepository {
  findAll(): Promise<Plan[]>
  findById(id: string): Promise<Plan | null>
  findFeaturesByPlanId(planId: string): Promise<PlanFeature[]>
}
