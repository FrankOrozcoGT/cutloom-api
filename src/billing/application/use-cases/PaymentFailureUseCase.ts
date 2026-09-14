import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository'

const GRACE_PERIOD_DAYS = 3

export interface MarkPastDueInput {
  recurrenteSubscriptionId: string
}

export interface DeactivateInput {
  recurrenteSubscriptionId: string
}

/**
 * Recurrente reintenta el cobro a los 3 y 5 días (ver docs.recurrente.com); si ambos
 * fallan, cancela la suscripción y emite subscription.cancel. Nuestra gracia de 3 días
 * es una regla de dominio propia (no inventamos un contador de reintentos que pueda
 * desincronizarse con la pasarela): mientras dure la gracia el entitlement sigue activo,
 * y el estado terminal siempre lo determina el webhook subscription.cancel de Recurrente.
 */
export class PaymentFailureUseCase {
  constructor(private readonly subscriptionRepository: SubscriptionRepository) {}

  async markPastDue(input: MarkPastDueInput): Promise<void> {
    const subscription = await this.subscriptionRepository.findByRecurrenteSubscriptionId(
      input.recurrenteSubscriptionId,
    )
    if (!subscription || subscription.status !== 'active') {
      return
    }

    const gracePeriodEndsAt = new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000)
    await this.subscriptionRepository.markPastDue(subscription.id, gracePeriodEndsAt)
  }

  /**
   * subscription.cancel de Recurrente llega tanto por impago agotado (estado previo
   * past_due) como por una cancelación voluntaria ya confirmada por nosotros vía DELETE
   * (CancelSubscriptionUseCase, Unidad 4). En ese segundo caso, si el ciclo pagado sigue
   * vigente (cancelAtPeriodEnd=true y aún no venció), el acceso debe seguir hasta el fin
   * de período — el downgrade real lo hace el job de vencimiento (ExpireCancelledSubscriptionsUseCase),
   * no este webhook. Solo desactivamos aquí de inmediato si no hay ciclo pagado que proteger.
   */
  async deactivate(input: DeactivateInput): Promise<void> {
    const subscription = await this.subscriptionRepository.findByRecurrenteSubscriptionId(
      input.recurrenteSubscriptionId,
    )
    if (!subscription || subscription.status === 'inactive') {
      return
    }

    if (subscription.cancelAtPeriodEnd && !subscription.isPeriodExpired()) {
      return
    }

    // El acceso se deriva en vivo de subscription.status (ver AuthorizeFeatureUsageUseCase)
    // — poner la suscripción en 'inactive' ya revoca todas sus features, sin tocar entitlements.
    await this.subscriptionRepository.updateStatus(subscription.id, 'inactive')
  }
}
