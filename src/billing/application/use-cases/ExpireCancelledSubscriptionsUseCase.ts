import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository'

/**
 * Recurrente no soporta cancelación "al fin de período" nativamente: cancelamos ya
 * mismo (CancelSubscriptionUseCase) pero mantenemos el acceso activo hasta
 * currentPeriodEnd, ya que el ciclo se pagó por adelantado. Este use case aplica el
 * downgrade cuando ese período vence — corre cada hora vía Bun.cron (ver server.ts).
 * El acceso se deriva en vivo de subscription.status (ver AuthorizeFeatureUsageUseCase),
 * así que poner la suscripción en 'inactive' ya revoca todas sus features.
 */
export class ExpireCancelledSubscriptionsUseCase {
  constructor(private readonly subscriptionRepository: SubscriptionRepository) {}

  async execute(now: Date = new Date()): Promise<void> {
    const expired = await this.subscriptionRepository.findExpiredPendingCancellation(now)
    if (expired.length === 0) {
      return
    }

    await this.subscriptionRepository.updateStatusForIds(
      expired.map((s) => s.id),
      'inactive',
    )
  }
}
