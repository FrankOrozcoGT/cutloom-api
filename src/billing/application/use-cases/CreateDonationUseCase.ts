import type { PaymentGatewayProvider } from '../../domain/ports/PaymentGatewayProvider'
import { MIN_ONE_TIME_PAYMENT_AMOUNT_IN_CENTS } from '../../domain/constants'

export class InvalidDonationAmountError extends Error {
  constructor() {
    super(`Donation amount must be at least ${MIN_ONE_TIME_PAYMENT_AMOUNT_IN_CENTS} cents`)
    this.name = 'InvalidDonationAmountError'
  }
}

export interface CreateDonationInput {
  organizationId: string | null
  amountInCents: number
  currency: string
  successUrl: string
  cancelUrl: string
}

export interface CreateDonationResult {
  donationUrl: string
}

/**
 * Ruta pública (sin authMiddleware, opt-in para free tier/visitantes). Usa el MODO
 * PAGO ÚNICO del mismo PaymentGatewayProvider que los créditos. La donación no
 * desbloquea entitlement ni toca el balance de créditos — es un flujo aislado dentro
 * de Billing (regla de arquitectura: donaciones no gatean features).
 */
export class CreateDonationUseCase {
  constructor(private readonly paymentGatewayProvider: PaymentGatewayProvider) {}

  async execute(input: CreateDonationInput): Promise<CreateDonationResult> {
    if (input.amountInCents < MIN_ONE_TIME_PAYMENT_AMOUNT_IN_CENTS) {
      throw new InvalidDonationAmountError()
    }

    const { checkoutUrl } = await this.paymentGatewayProvider.createOneTimePaymentSession({
      amountInCents: input.amountInCents,
      currency: input.currency,
      name: 'Dame un café',
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      metadata: { organizationId: input.organizationId ?? '', purpose: 'donation' },
    })

    return { donationUrl: checkoutUrl }
  }
}
