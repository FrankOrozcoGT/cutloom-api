import type { Plan } from '../../domain/entities/Plan'
import type {
  ChangePlanResult,
  CheckoutSessionResult,
  CheckoutStatus,
  OneTimePaymentSessionResult,
  PaymentGatewayProvider,
  SubscriptionDetails,
  WebhookHeaders,
} from '../../domain/ports/PaymentGatewayProvider'

export interface RecurrenteConfig {
  apiKey: string
  webhookSecret: string
  baseUrl: string
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchOrThrow(url: string, init: RequestInit, errorContext: string): Promise<Response> {
  const res = await fetchWithTimeout(url, init)
  if (!res.ok) {
    throw new Error(`${errorContext}: ${await res.text()}`)
  }
  return res
}

/**
 * Implementación del puerto PaymentGatewayProvider para la pasarela Recurrente
 * (docs.recurrente.com). Firma de webhook estilo Svix; checkout con price_id de
 * catálogo (única forma confirmada de que Recurrente genere un objeto Subscription
 * real y dispare subscription.create).
 */
export class RecurrentePaymentGatewayProvider implements PaymentGatewayProvider {
  constructor(private readonly config: RecurrenteConfig) {}

  async createCheckoutSession(
    plan: Plan,
    organizationId: string,
    urls: { successUrl: string; cancelUrl: string },
  ): Promise<CheckoutSessionResult> {
    const res = await fetchOrThrow(
      `${this.config.baseUrl}/checkouts`,
      {
        method: 'POST',
        headers: { 'X-SECRET-KEY': this.config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ price_id: plan.recurrentePriceId, quantity: 1 }],
          success_url: urls.successUrl,
          cancel_url: urls.cancelUrl,
          metadata: { organizationId, planId: plan.id },
        }),
      },
      'Recurrente checkout creation failed',
    )

    const data = (await res.json()) as { id: string; checkout_url: string }
    return { checkoutId: data.id, checkoutUrl: data.checkout_url }
  }

  async cancelSubscription(recurrenteSubscriptionId: string): Promise<void> {
    await fetchOrThrow(
      `${this.config.baseUrl}/subscriptions/${recurrenteSubscriptionId}`,
      { method: 'DELETE', headers: { 'X-SECRET-KEY': this.config.apiKey } },
      'Recurrente cancel subscription failed',
    )
  }

  async changePlan(recurrenteSubscriptionId: string, fromPlan: Plan, toPlan: Plan): Promise<ChangePlanResult> {
    const res = await fetchOrThrow(
      `${this.config.baseUrl}/subscriptions/${recurrenteSubscriptionId}`,
      {
        method: 'PUT',
        headers: { 'X-SECRET-KEY': this.config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { price_id: fromPlan.recurrentePriceId, deleted: true },
            { price_id: toPlan.recurrentePriceId },
          ],
          mode: 'now_and_charge',
        }),
      },
      'Recurrente change plan failed',
    )

    const data = (await res.json()) as {
      current_period_start?: string
      current_period_end: string
      proration_charge?: { amount_in_cents?: number }
    }
    return {
      currentPeriodStart: data.current_period_start ? new Date(data.current_period_start) : new Date(),
      currentPeriodEnd: new Date(data.current_period_end),
      proratedAmountInCents: data.proration_charge?.amount_in_cents ?? 0,
    }
  }

  /**
   * El webhook (payment_intent.succeeded, subscription.create, etc) no trae
   * current_period_start/end de forma confiable — se consulta aparte contra la API
   * (mismo patrón ya usado y probado en producción: GET /subscriptions/{id}).
   */
  async getSubscriptionDetails(recurrenteSubscriptionId: string): Promise<SubscriptionDetails> {
    const res = await fetchOrThrow(
      `${this.config.baseUrl}/subscriptions/${recurrenteSubscriptionId}`,
      { method: 'GET', headers: { 'X-SECRET-KEY': this.config.apiKey } },
      'Recurrente subscription lookup failed',
    )

    const data = (await res.json()) as {
      status: string
      current_period_start?: string | null
      current_period_end?: string | null
    }

    return {
      status: data.status,
      currentPeriodStart: data.current_period_start ? new Date(data.current_period_start) : null,
      currentPeriodEnd: data.current_period_end ? new Date(data.current_period_end) : null,
    }
  }

  /** Consultado desde el callback de retorno (backend) tras el redirect de Recurrente, sin depender de cookies. */
  async getCheckoutStatus(checkoutId: string): Promise<CheckoutStatus> {
    const res = await fetchOrThrow(
      `${this.config.baseUrl}/checkouts/${checkoutId}`,
      { method: 'GET', headers: { 'X-SECRET-KEY': this.config.apiKey } },
      'Recurrente checkout lookup failed',
    )

    const data = (await res.json()) as { status: string }
    return { status: data.status }
  }

  async createOneTimePaymentSession(input: {
    amountInCents: number
    currency: string
    name: string
    successUrl: string
    cancelUrl: string
    metadata: Record<string, string>
  }): Promise<OneTimePaymentSessionResult> {
    const res = await fetchOrThrow(
      `${this.config.baseUrl}/checkouts`,
      {
        method: 'POST',
        headers: { 'X-SECRET-KEY': this.config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              name: input.name,
              amount_in_cents: input.amountInCents,
              currency: input.currency,
              quantity: 1,
              charge_type: 'one_time',
            },
          ],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          metadata: input.metadata,
        }),
      },
      'Recurrente one-time checkout creation failed',
    )

    const data = (await res.json()) as { id: string; checkout_url: string }
    return { checkoutId: data.id, checkoutUrl: data.checkout_url }
  }

  async verifyWebhookSignature(rawBody: string, headers: WebhookHeaders): Promise<boolean> {
    try {
      const secretB64 = this.config.webhookSecret.replace(/^whsec_/, '')
      const keyBytes = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0))

      const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
      ])

      const signedContent = `${headers.svixId}.${headers.svixTimestamp}.${rawBody}`
      const signatureBuf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(signedContent))
      const expectedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuf)))

      const receivedSignatures = headers.svixSignature
        .split(' ')
        .map((s) => s.split(',')[1])
        .filter((sig): sig is string => Boolean(sig))

      return receivedSignatures.some((sig) => timingSafeEqual(sig, expectedSignature))
    } catch {
      return false
    }
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}
