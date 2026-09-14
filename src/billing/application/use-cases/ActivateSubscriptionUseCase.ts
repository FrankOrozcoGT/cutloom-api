import type { EntitlementRepository } from '../../domain/ports/EntitlementRepository'
import type { PlanRepository } from '../../domain/ports/PlanRepository'
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository'

export interface ActivateSubscriptionInput {
  recurrenteCheckoutId: string
  recurrenteSubscriptionId: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
}

/**
 * Se dispara desde el webhook payment/subscription al confirmarse el primer cobro
 * de una suscripción recién creada (payload de checkout ya vinculado a la
 * organización vía upsertByOrganizationId en CreateCheckoutSessionUseCase).
 */
export class ActivateSubscriptionUseCase {
  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly entitlementRepository: EntitlementRepository,
    private readonly planRepository: PlanRepository,
  ) {}

  async execute(input: ActivateSubscriptionInput): Promise<void> {
    const subscription = await this.subscriptionRepository.findByRecurrenteCheckoutId(input.recurrenteCheckoutId)
    if (!subscription) {
      return
    }

    if (subscription.status === 'active' && subscription.recurrenteSubscriptionId === input.recurrenteSubscriptionId) {
      return
    }

    const plan = await this.planRepository.findById(subscription.planId)
    if (!plan) {
      return
    }

    await this.subscriptionRepository.upsertByOrganizationId({
      organizationId: subscription.organizationId,
      planId: subscription.planId,
      recurrenteSubscriptionId: input.recurrenteSubscriptionId,
      recurrenteCheckoutId: input.recurrenteCheckoutId,
      status: 'active',
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
    })

    // El acceso en sí se deriva en vivo de subscription.status + plan_features (ver
    // AuthorizeFeatureUsageUseCase) — acá solo se reinicia el consumo del nuevo ciclo.
    const planFeatures = await this.planRepository.findFeaturesByPlanId(plan.id)
    await this.entitlementRepository.resetUsageForFeatures(
      subscription.organizationId,
      planFeatures.map((f) => f.feature),
    )
  }
}
