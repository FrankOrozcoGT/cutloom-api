import type { PlanRepository } from '../../domain/ports/PlanRepository'
import type { PaymentGatewayProvider } from '../../domain/ports/PaymentGatewayProvider'
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository'

export class PlanNotFoundError extends Error {
  constructor(planId: string) {
    super(`Plan not found: ${planId}`)
    this.name = 'PlanNotFoundError'
  }
}

export interface CreateCheckoutSessionInput {
  organizationId: string
  planId: string
  /** Base del callback en el backend (ver checkoutReturnRoutes) — puente antes de aterrizar en el frontend. */
  returnUrlBase: string
}

export interface CreateCheckoutSessionResult {
  checkoutUrl: string
}

/**
 * success_url/cancel_url apuntan al backend (checkoutReturnRoutes), no directo al
 * frontend: así el navegador aterriza primero en nuestro propio dominio (mismo origen
 * que sirvió la cookie de refresh token) antes del salto final hacia el frontend,
 * evitando que "sameSite: strict" descarte la cookie en la navegación cross-site que
 * viene de app.recurrente.com. El backend no necesita reconsultar el pago aquí — la
 * confirmación real llega aparte por webhook (ActivateSubscriptionUseCase); este
 * callback solo reenvía el resultado (success/cancel) que nosotros mismos definimos.
 */
export class CreateCheckoutSessionUseCase {
  constructor(
    private readonly planRepository: PlanRepository,
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly paymentGatewayProvider: PaymentGatewayProvider,
  ) {}

  async execute(input: CreateCheckoutSessionInput): Promise<CreateCheckoutSessionResult> {
    const plan = await this.planRepository.findById(input.planId)
    if (!plan) {
      throw new PlanNotFoundError(input.planId)
    }

    const successUrl = new URL(input.returnUrlBase)
    successUrl.searchParams.set('result', 'success')
    const cancelUrl = new URL(input.returnUrlBase)
    cancelUrl.searchParams.set('result', 'cancel')

    const { checkoutId, checkoutUrl } = await this.paymentGatewayProvider.createCheckoutSession(
      plan,
      input.organizationId,
      { successUrl: successUrl.toString(), cancelUrl: cancelUrl.toString() },
    )

    await this.subscriptionRepository.upsertByOrganizationId({
      organizationId: input.organizationId,
      planId: plan.id,
      recurrenteSubscriptionId: null,
      recurrenteCheckoutId: checkoutId,
      status: 'inactive',
      currentPeriodStart: null,
      currentPeriodEnd: null,
    })

    return { checkoutUrl }
  }
}
