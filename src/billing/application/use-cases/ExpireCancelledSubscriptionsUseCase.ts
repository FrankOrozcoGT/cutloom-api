import type { EntitlementRepository } from '../../domain/ports/EntitlementRepository'
import type { PlanRepository } from '../../domain/ports/PlanRepository'
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository'

/**
 * Recurrente no soporta cancelación "al fin de período" nativamente: cancelamos ya
 * mismo (CancelSubscriptionUseCase) pero mantenemos el entitlement activo hasta
 * currentPeriodEnd, ya que el ciclo se pagó por adelantado. Este use case aplica el
 * downgrade cuando ese período vence — corre cada hora vía Bun.cron (ver server.ts).
 */
export class ExpireCancelledSubscriptionsUseCase {
  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly entitlementRepository: EntitlementRepository,
    private readonly planRepository: PlanRepository,
  ) {}

  async execute(now: Date = new Date()): Promise<void> {
    const expired = await this.subscriptionRepository.findExpiredPendingCancellation(now)
    if (expired.length === 0) {
      return
    }

    const uniquePlanIds = [...new Set(expired.map((s) => s.planId))]
    const featuresByPlanId = await this.planRepository.findFeaturesByPlanIds(uniquePlanIds)

    await Promise.all(
      expired.map(async (subscription) => {
        await this.subscriptionRepository.updateStatus(subscription.id, 'inactive')
        const features = featuresByPlanId.get(subscription.planId) ?? []
        await this.entitlementRepository.deactivateAll(
          subscription.organizationId,
          features.map((f) => f.feature),
        )
      }),
    )
  }
}
