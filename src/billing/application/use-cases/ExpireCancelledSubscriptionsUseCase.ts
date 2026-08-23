import type { EntitlementRepository } from '../../domain/ports/EntitlementRepository'
import type { PlanRepository } from '../../domain/ports/PlanRepository'
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository'

/**
 * Recurrente no soporta cancelación "al fin de período" nativamente: cancelamos ya
 * mismo (CancelSubscriptionUseCase) pero mantenemos el entitlement activo hasta
 * currentPeriodEnd, ya que el ciclo se pagó por adelantado. Este use case es el que
 * efectivamente aplica el downgrade cuando ese período vence — pensado para correr
 * periódicamente (cron) o de forma lazy antes de resolver el entitlement de un tenant.
 */
export class ExpireCancelledSubscriptionsUseCase {
  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly entitlementRepository: EntitlementRepository,
    private readonly planRepository: PlanRepository,
  ) {}

  async execute(now: Date = new Date()): Promise<void> {
    const expired = await this.subscriptionRepository.findExpiredPendingCancellation(now)

    for (const subscription of expired) {
      await this.subscriptionRepository.updateStatus(subscription.id, 'inactive')
      const planFeatures = await this.planRepository.findFeaturesByPlanId(subscription.planId)
      for (const planFeature of planFeatures) {
        await this.entitlementRepository.setActive(subscription.organizationId, planFeature.feature, false)
      }
    }
  }
}
