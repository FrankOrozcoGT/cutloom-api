import type { EntitlementRepository } from '../../domain/ports/EntitlementRepository'
import type { PlanRepository } from '../../domain/ports/PlanRepository'
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository'

export interface RenewalInput {
  recurrenteSubscriptionId: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
}

/**
 * Se dispara en cada ciclo de cobro exitoso de una suscripción ya activa
 * (evento real de Recurrente: intent.succeeded con subscription.id existente).
 * Idempotente: si el periodEnd reportado no es posterior al que ya tenemos,
 * no hace nada (evita doble extensión ante reintentos de entrega del webhook).
 * Un nuevo ciclo también resetea el contador de uso de cada feature con tope
 * (usageLimit) del plan — el consumo del ciclo anterior no se arrastra.
 */
export class RenewalUseCase {
  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly entitlementRepository: EntitlementRepository,
    private readonly planRepository: PlanRepository,
  ) {}

  async execute(input: RenewalInput): Promise<void> {
    const subscription = await this.subscriptionRepository.findByRecurrenteSubscriptionId(
      input.recurrenteSubscriptionId,
    )
    if (!subscription) {
      return
    }

    if (subscription.currentPeriodEnd && input.currentPeriodEnd <= subscription.currentPeriodEnd) {
      return
    }

    await this.subscriptionRepository.extendPeriod(subscription.id, input.currentPeriodStart, input.currentPeriodEnd)

    const planFeatures = await this.planRepository.findFeaturesByPlanId(subscription.planId)
    await this.entitlementRepository.grantAll(
      subscription.organizationId,
      planFeatures.map((f) => f.feature),
    )
  }
}
