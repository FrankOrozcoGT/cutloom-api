import type { Plan } from '../entities/Plan'

export interface CheckoutSessionResult {
  checkoutId: string
  checkoutUrl: string
}

export interface OneTimePaymentSessionResult {
  checkoutId: string
  checkoutUrl: string
}

export interface ChangePlanResult {
  currentPeriodStart: Date
  currentPeriodEnd: Date
  proratedAmountInCents: number
}

export interface SubscriptionDetails {
  status: string
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
}

export interface CheckoutStatus {
  status: string // 'paid' | 'unpaid' | 'expired' | ...
}

export interface WebhookHeaders {
  svixId: string
  svixTimestamp: string
  svixSignature: string
}

/**
 * Puerto único, agnóstico de la pasarela concreta, con dos modos de cobro:
 * recurrente (suscripciones) y pago único (créditos, donaciones).
 */
export interface PaymentGatewayProvider {
  // Modo recurrente
  createCheckoutSession(
    plan: Plan,
    organizationId: string,
    urls: { successUrl: string; cancelUrl: string },
  ): Promise<CheckoutSessionResult>
  cancelSubscription(recurrenteSubscriptionId: string): Promise<void>
  changePlan(recurrenteSubscriptionId: string, fromPlan: Plan, toPlan: Plan): Promise<ChangePlanResult>
  /**
   * El webhook de Recurrente no trae current_period_end de forma confiable (confirmado
   * contra payloads reales) — hay que consultarlo aparte tras cada evento de pago/suscripción.
   */
  getSubscriptionDetails(recurrenteSubscriptionId: string): Promise<SubscriptionDetails>
  /** Consultado desde el callback de retorno del checkout (backend), sin depender de cookies de sesión. */
  getCheckoutStatus(checkoutId: string): Promise<CheckoutStatus>

  // Modo pago único
  createOneTimePaymentSession(input: {
    amountInCents: number
    currency: string
    name: string
    successUrl: string
    cancelUrl: string
    metadata: Record<string, string>
  }): Promise<OneTimePaymentSessionResult>

  // Común
  verifyWebhookSignature(rawBody: string, headers: WebhookHeaders): Promise<boolean>
}
