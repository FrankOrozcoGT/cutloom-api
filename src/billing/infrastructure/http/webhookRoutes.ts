import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PaymentGatewayProvider } from '../../domain/ports/PaymentGatewayProvider'
import type { ActivateSubscriptionUseCase } from '../../application/use-cases/ActivateSubscriptionUseCase'
import type { RenewalUseCase } from '../../application/use-cases/RenewalUseCase'
import type { PaymentFailureUseCase } from '../../application/use-cases/PaymentFailureUseCase'
import type { TopUpCreditsUseCase } from '../../application/use-cases/TopUpCreditsUseCase'
import type { RecordDonationUseCase } from '../../application/use-cases/RecordDonationUseCase'

interface RecurrenteCheckoutPayload {
  id: string
  metadata?: Record<string, string>
  total_in_cents?: number
  currency?: string
}

interface RecurrentePaymentEventPayload {
  // payment_intent.* es el namespace real para pagos con tarjeta (confirmado en payloads
  // LIVE/test reales) — intent.*/setup_intent.* son los nombres "unificados" que documenta
  // la introducción general de la API pero no los que efectivamente llegan por webhook.
  event_type: 'payment_intent.succeeded' | 'payment_intent.failed' | 'intent.succeeded' | 'intent.failed' | 'setup_intent.succeeded'
  id: string
  checkout?: RecurrenteCheckoutPayload
  // Solo trae el id (confirmado en payloads reales) — el período de facturación no viene
  // en el webhook, se consulta aparte vía PaymentGatewayProvider.getSubscriptionDetails.
  subscription?: { id: string }
}

interface RecurrenteSubscriptionEventPayload {
  event_type:
    | 'subscription.create'
    | 'subscription.cancel'
    | 'subscription.past_due'
    | 'subscription.pause'
    | 'subscription.unpause'
    | 'subscription.reactivate'
  id: string
  customer_email?: string
}

export interface WebhookModule {
  activateSubscriptionUseCase: ActivateSubscriptionUseCase
  renewalUseCase: RenewalUseCase
  paymentFailureUseCase: PaymentFailureUseCase
  topUpCreditsUseCase: TopUpCreditsUseCase
  recordDonationUseCase: RecordDonationUseCase
  paymentGatewayProvider: PaymentGatewayProvider
}

function extractSvixHeaders(req: FastifyRequest) {
  return {
    svixId: req.headers['svix-id'] as string,
    svixTimestamp: req.headers['svix-timestamp'] as string,
    svixSignature: req.headers['svix-signature'] as string,
  }
}

export function registerWebhookRoutes(app: FastifyInstance, module: WebhookModule) {
  app.register(
    (webhookApp, _opts, done) => {
      // Content-type parser scoped a este plugin: preserva el raw body como string
      // para poder validar la firma Svix (HMAC sobre el body crudo, no el JSON reparseado).
      webhookApp.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, cb) => {
        cb(null, body)
      })

      webhookApp.post('/recurrente', async (req, reply) => {
        const rawBody = req.body as string
        const headers = extractSvixHeaders(req)

        if (!headers.svixId || !headers.svixTimestamp || !headers.svixSignature) {
          return reply.status(400).send({ error: 'MISSING_SIGNATURE_HEADERS' })
        }

        const isValid = await module.paymentGatewayProvider.verifyWebhookSignature(rawBody, headers)
        if (!isValid) {
          return reply.status(400).send({ error: 'INVALID_SIGNATURE' })
        }

        const payload = JSON.parse(rawBody) as { event_type?: string } & Record<string, unknown>

        if (
          payload.event_type === 'payment_intent.succeeded' ||
          payload.event_type === 'intent.succeeded' ||
          payload.event_type === 'setup_intent.succeeded'
        ) {
          await handlePaymentSucceeded(payload as unknown as RecurrentePaymentEventPayload, module)
          return reply.status(200).send({ ok: true })
        }

        if (payload.event_type === 'payment_intent.failed' || payload.event_type === 'intent.failed') {
          await handlePaymentFailed(payload as unknown as RecurrentePaymentEventPayload, module)
          return reply.status(200).send({ ok: true })
        }

        if (typeof payload.event_type === 'string' && payload.event_type.startsWith('subscription.')) {
          await handleSubscriptionEvent(payload as unknown as RecurrenteSubscriptionEventPayload, module)
          return reply.status(200).send({ ok: true })
        }

        return reply.status(200).send({ ok: true })
      })

      done()
    },
    { prefix: '/api/billing/webhooks' },
  )
}

async function handlePaymentSucceeded(payload: RecurrentePaymentEventPayload, module: WebhookModule) {
  const checkout = payload.checkout
  const metadata = checkout?.metadata

  // Donaciones y créditos no traen subscription — se distinguen por metadata.purpose
  // (seteada al crear el checkout de pago único, ver TopUpCreditsUseCase/CreateDonationUseCase).
  if (metadata?.purpose === 'credits_topup' && checkout && metadata.organizationId) {
    await module.topUpCreditsUseCase.confirmPayment({
      organizationId: metadata.organizationId,
      amountInCents: checkout.total_in_cents ?? 0,
      recurrenteCheckoutId: checkout.id,
    })
    return
  }

  if (metadata?.purpose === 'donation' && checkout) {
    await module.recordDonationUseCase.execute({
      organizationId: metadata.organizationId || null,
      amountInCents: checkout.total_in_cents ?? 0,
      currency: checkout.currency ?? 'GTQ',
      recurrenteCheckoutId: checkout.id,
    })
    return
  }

  const subscriptionId = payload.subscription?.id
  if (!checkout || !subscriptionId) {
    return
  }

  // El webhook no trae el período de facturación (confirmado en payloads reales) —
  // se consulta aparte contra la API antes de activar/renovar.
  const details = await module.paymentGatewayProvider.getSubscriptionDetails(subscriptionId)
  if (!details.currentPeriodEnd) {
    return
  }

  // Primera activación (checkout aún inactive en nuestra BD) vs. renovación de una
  // suscripción ya activa se distinguen dentro de cada use case por idempotencia
  // (ActivateSubscriptionUseCase busca por checkoutId; RenewalUseCase busca por subscriptionId).
  await module.activateSubscriptionUseCase.execute({
    recurrenteCheckoutId: checkout.id,
    recurrenteSubscriptionId: subscriptionId,
    currentPeriodStart: details.currentPeriodStart ?? new Date(),
    currentPeriodEnd: details.currentPeriodEnd,
  })

  await module.renewalUseCase.execute({
    recurrenteSubscriptionId: subscriptionId,
    currentPeriodStart: details.currentPeriodStart ?? new Date(),
    currentPeriodEnd: details.currentPeriodEnd,
  })
}

async function handlePaymentFailed(payload: RecurrentePaymentEventPayload, module: WebhookModule) {
  const subscriptionId = payload.subscription?.id
  if (!subscriptionId) return

  await module.paymentFailureUseCase.markPastDue({ recurrenteSubscriptionId: subscriptionId })
}

async function handleSubscriptionEvent(payload: RecurrenteSubscriptionEventPayload, module: WebhookModule) {
  // subscription.create es informativo (no trae checkout_id) — la activación real ocurre
  // en handlePaymentSucceeded, que sí vincula checkout.id + subscription.id.
  if (payload.event_type === 'subscription.cancel') {
    await module.paymentFailureUseCase.deactivate({ recurrenteSubscriptionId: payload.id })
    return
  }
}
