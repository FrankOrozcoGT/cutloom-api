import type { EntitlementRepository } from '../../domain/ports/EntitlementRepository'
import type { PaymentGatewayProvider } from '../../domain/ports/PaymentGatewayProvider'
import type { PlanRepository } from '../../domain/ports/PlanRepository'
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository'
import { NoActiveSubscriptionError, PlanNotFoundError } from '../../domain/errors'

export class SubscriptionNotEligibleForPlanChangeError extends Error {
  constructor() {
    super('Subscription must be active (not past_due or cancelled) to change plan')
    this.name = 'SubscriptionNotEligibleForPlanChangeError'
  }
}

export interface ChangePlanInput {
  organizationId: string
  newPlanId: string
}

export interface ChangePlanResult {
  status: 'active'
  planId: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
  proratedAmountInCents: number
}

/**
 * Cambio de plan a mitad de ciclo usando el prorrateo nativo de Recurrente
 * (PUT /subscriptions/{id} con items: [{price_id viejo, deleted:true}, {price_id nuevo}],
 * mode: now_and_charge) — misma suscripción (su_...), sin cancelar/crear una nueva.
 * Recurrente cobra de inmediato el neto (crédito días no usados del plan viejo menos
 * cargo de los días restantes al precio nuevo) y sigue gestionando el ciclo de cobro
 * futuro sin intervención nuestra.
 */
export class ChangePlanUseCase {
  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly entitlementRepository: EntitlementRepository,
    private readonly planRepository: PlanRepository,
    private readonly paymentGatewayProvider: PaymentGatewayProvider,
  ) {}

  async execute(input: ChangePlanInput): Promise<ChangePlanResult> {
    const subscription = await this.subscriptionRepository.findByOrganizationId(input.organizationId)
    if (!subscription || !subscription.recurrenteSubscriptionId) {
      throw new NoActiveSubscriptionError(input.organizationId)
    }

    if (subscription.status !== 'active' || subscription.cancelAtPeriodEnd) {
      throw new SubscriptionNotEligibleForPlanChangeError()
    }

    const currentPlan = await this.planRepository.findById(subscription.planId)
    const newPlan = await this.planRepository.findById(input.newPlanId)
    if (!currentPlan) throw new PlanNotFoundError(subscription.planId)
    if (!newPlan) throw new PlanNotFoundError(input.newPlanId)

    const result = await this.paymentGatewayProvider.changePlan(
      subscription.recurrenteSubscriptionId,
      currentPlan,
      newPlan,
    )

    await this.subscriptionRepository.updatePlan(
      subscription.id,
      newPlan.id,
      result.currentPeriodStart,
      result.currentPeriodEnd,
    )

    // El acceso en sí se deriva en vivo de subscription.planId (ya actualizado arriba) +
    // plan_features (ver AuthorizeFeatureUsageUseCase) — no hace falta otorgar ni desactivar
    // nada acá. Solo se reinicia el consumo de las features del plan nuevo, para que el
    // cambio de plan no herede contador de uso acumulado bajo un tope distinto.
    const newPlanFeatures = await this.planRepository.findFeaturesByPlanId(newPlan.id)
    await this.entitlementRepository.resetUsageForFeatures(
      subscription.organizationId,
      newPlanFeatures.map((f) => f.feature),
    )

    return {
      status: 'active',
      planId: newPlan.id,
      currentPeriodStart: result.currentPeriodStart,
      currentPeriodEnd: result.currentPeriodEnd,
      proratedAmountInCents: result.proratedAmountInCents,
    }
  }
}
