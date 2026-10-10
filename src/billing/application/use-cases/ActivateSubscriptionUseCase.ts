import type { CreditAccountRepository } from '../../domain/ports/CreditAccountRepository'
import type { PlanRepository } from '../../domain/ports/PlanRepository'
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository'

export interface ActivateSubscriptionInput {
  recurrenteCheckoutId: string
  recurrenteSubscriptionId: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Se dispara desde el webhook payment/subscription al confirmarse el primer cobro
 * de una suscripción recién creada (payload de checkout ya vinculado a la
 * organización vía upsertByOrganizationId en CreateCheckoutSessionUseCase).
 */
export class ActivateSubscriptionUseCase {
  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly creditAccountRepository: CreditAccountRepository,
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

    // Qué features cubre el plan se deriva en vivo de subscription.status + plan_features (ver
    // AuthorizeFeatureUsageUseCase) — acá solo se acredita el pozo único de créditos del ciclo.
    // El primer grant se prorratea a los días reales hasta el próximo corte (currentPeriodEnd,
    // que Recurrente ya ancla al día 1 — ver billing_cycle_anchor_day en
    // RecurrentePaymentGatewayProvider.createCheckoutSession), igual trato que el dinero: quien
    // entra a mitad de mes paga y recibe lo proporcional, nunca el mes completo.
    const daysUntilNextCycle = Math.max(
      1,
      Math.round((input.currentPeriodEnd.getTime() - input.currentPeriodStart.getTime()) / MILLISECONDS_PER_DAY),
    )
    const proratedCredits = Math.round((plan.creditsPerCycle * daysUntilNextCycle) / 30)

    await this.creditAccountRepository.grantFromPlan(
      subscription.organizationId,
      proratedCredits,
      subscription.id,
      input.currentPeriodStart,
    )
  }
}
