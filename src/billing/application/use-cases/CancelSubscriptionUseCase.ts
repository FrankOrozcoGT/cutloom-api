import type { EntitlementRepository } from '../../domain/ports/EntitlementRepository'
import type { PaymentGatewayProvider } from '../../domain/ports/PaymentGatewayProvider'
import type { PlanRepository } from '../../domain/ports/PlanRepository'
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository'
import { NoActiveSubscriptionError } from '../../domain/errors'

export interface CancelSubscriptionInput {
  organizationId: string
}

export interface CancelSubscriptionResult {
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: Date | null
}

/**
 * Recurrente cancela de inmediato (DELETE /subscriptions/{id}, sin flag atPeriodEnd
 * nativo) y el ciclo ya está pagado por adelantado, así que cancelar ahí no nos quita
 * nada ya cobrado. El acceso "hasta fin de período" que pide el negocio se simula en
 * nuestra propia BD: si había un ciclo pagado vigente (status active), el entitlement
 * sigue activo y el downgrade real lo hace el job de vencimiento cuando currentPeriodEnd
 * pase. Si no había ciclo pagado vigente (status past_due, el cobro de este ciclo ya
 * falló), no hay nada que proteger y se desactiva de inmediato.
 */
export class CancelSubscriptionUseCase {
  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly entitlementRepository: EntitlementRepository,
    private readonly planRepository: PlanRepository,
    private readonly paymentGatewayProvider: PaymentGatewayProvider,
  ) {}

  async execute(input: CancelSubscriptionInput): Promise<CancelSubscriptionResult> {
    const subscription = await this.subscriptionRepository.findByOrganizationId(input.organizationId)
    if (!subscription || subscription.status === 'inactive' || !subscription.recurrenteSubscriptionId) {
      throw new NoActiveSubscriptionError(input.organizationId)
    }

    if (subscription.cancelAtPeriodEnd) {
      return { cancelAtPeriodEnd: true, currentPeriodEnd: subscription.currentPeriodEnd }
    }

    await this.paymentGatewayProvider.cancelSubscription(subscription.recurrenteSubscriptionId)

    if (subscription.status === 'past_due' || subscription.isPeriodExpired()) {
      await this.subscriptionRepository.updateStatus(subscription.id, 'inactive')
      const planFeatures = await this.planRepository.findFeaturesByPlanId(subscription.planId)
      await this.entitlementRepository.deactivateAll(
        subscription.organizationId,
        planFeatures.map((f) => f.feature),
      )
      return { cancelAtPeriodEnd: false, currentPeriodEnd: subscription.currentPeriodEnd }
    }

    await this.subscriptionRepository.setCancelAtPeriodEnd(subscription.id, true)
    return { cancelAtPeriodEnd: true, currentPeriodEnd: subscription.currentPeriodEnd }
  }
}
