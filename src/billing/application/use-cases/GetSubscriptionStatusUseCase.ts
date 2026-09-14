import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository'
import type { SubscriptionStatus } from '../../domain/entities/Subscription'

export interface GetSubscriptionStatusResult {
  planId: string
  status: SubscriptionStatus
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
}

export class GetSubscriptionStatusUseCase {
  constructor(private readonly subscriptionRepository: SubscriptionRepository) {}

  async execute(organizationId: string): Promise<GetSubscriptionStatusResult | null> {
    const subscription = await this.subscriptionRepository.findByOrganizationId(organizationId)
    if (!subscription) return null

    return {
      planId: subscription.planId,
      status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    }
  }
}
