import type { CreditAccountRepository } from '../../domain/ports/CreditAccountRepository'
import type { PaymentGatewayProvider } from '../../domain/ports/PaymentGatewayProvider'

const MIN_TOPUP_AMOUNT_IN_CENTS = 500 // Q5 / mínimo de Recurrente para checkouts one_time

export class InvalidTopUpAmountError extends Error {
  constructor() {
    super(`Top-up amount must be at least ${MIN_TOPUP_AMOUNT_IN_CENTS} cents`)
    this.name = 'InvalidTopUpAmountError'
  }
}

export interface TopUpCreditsInput {
  organizationId: string
  amountInCents: number
  currency: string
  successUrl: string
  cancelUrl: string
}

export interface TopUpCreditsResult {
  checkoutUrl: string
}

/**
 * Créditos = pago por uso (one-time), sin renovación ni entitlement. Usa el MODO
 * PAGO ÚNICO del mismo PaymentGatewayProvider que las suscripciones (createOneTimePaymentSession).
 * El incremento real del balance ocurre en confirmPayment, llamado desde el webhook
 * payment.completed cuando metadata.purpose === 'credits_topup' (ver webhookRoutes.ts).
 */
export class TopUpCreditsUseCase {
  constructor(
    private readonly creditAccountRepository: CreditAccountRepository,
    private readonly paymentGatewayProvider: PaymentGatewayProvider,
  ) {}

  async execute(input: TopUpCreditsInput): Promise<TopUpCreditsResult> {
    if (input.amountInCents < MIN_TOPUP_AMOUNT_IN_CENTS) {
      throw new InvalidTopUpAmountError()
    }

    const { checkoutUrl } = await this.paymentGatewayProvider.createOneTimePaymentSession({
      amountInCents: input.amountInCents,
      currency: input.currency,
      name: 'Recarga de créditos',
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      metadata: { organizationId: input.organizationId, purpose: 'credits_topup' },
    })

    return { checkoutUrl }
  }

  /** Invocado desde el webhook tras confirmar el pago único de la recarga. Idempotente por checkoutId. */
  async confirmPayment(input: { organizationId: string; amountInCents: number; recurrenteCheckoutId: string }): Promise<void> {
    await this.creditAccountRepository.addCredits(input.organizationId, input.amountInCents, input.recurrenteCheckoutId)
  }
}
