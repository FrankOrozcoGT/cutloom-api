import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PaymentGatewayProvider, WebhookHeaders } from '../../domain/ports/PaymentGatewayProvider'
import type { ActivateSubscriptionUseCase } from '../../application/use-cases/ActivateSubscriptionUseCase'
import type { RenewalUseCase } from '../../application/use-cases/RenewalUseCase'
import type { PaymentFailureUseCase } from '../../application/use-cases/PaymentFailureUseCase'
import type { TopUpCreditsUseCase } from '../../application/use-cases/TopUpCreditsUseCase'
import type { RecordDonationUseCase } from '../../application/use-cases/RecordDonationUseCase'
import { isRecord } from '../../../shared/domain/validation'

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


/** Primer punto de validación de forma del webhook: solo extrae el discriminante de ruteo. */
function parseEventType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.event_type === 'string' ? value.event_type : undefined
}

const PAYMENT_EVENT_TYPES = [
  'payment_intent.succeeded',
  'payment_intent.failed',
  'intent.succeeded',
  'intent.failed',
  'setup_intent.succeeded',
] as const satisfies readonly RecurrentePaymentEventPayload['event_type'][]

function parseStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new Error('Expected a record of string values')
  }
  return value as Record<string, string>
}

function parseCheckoutPayload(value: unknown): RecurrenteCheckoutPayload {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('Recurrente checkout payload missing id')
  }
  return {
    id: value.id,
    metadata: value.metadata !== undefined ? parseStringRecord(value.metadata) : undefined,
    total_in_cents: typeof value.total_in_cents === 'number' ? value.total_in_cents : undefined,
    currency: typeof value.currency === 'string' ? value.currency : undefined,
  }
}

/** Único punto de validación de forma completa del webhook — de aquí en adelante el tipo se propaga sin recastear. */
function parsePaymentEventPayload(value: unknown): RecurrentePaymentEventPayload {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('Recurrente payment event payload missing id')
  }
  const eventType = PAYMENT_EVENT_TYPES.find((t) => t === value.event_type)
  if (!eventType) {
    throw new Error('Recurrente payment event payload has unknown event_type')
  }
  const subscription = value.subscription
  if (subscription !== undefined && (!isRecord(subscription) || typeof subscription.id !== 'string')) {
    throw new Error('Recurrente payment event payload has malformed subscription')
  }
  return {
    event_type: eventType,
    id: value.id,
    checkout: value.checkout !== undefined ? parseCheckoutPayload(value.checkout) : undefined,
    subscription: isRecord(subscription) && typeof subscription.id === 'string' ? { id: subscription.id } : undefined,
  }
}

const SUBSCRIPTION_EVENT_TYPES = [
  'subscription.create',
  'subscription.cancel',
  'subscription.past_due',
  'subscription.pause',
  'subscription.unpause',
  'subscription.reactivate',
] as const satisfies readonly RecurrenteSubscriptionEventPayload['event_type'][]

function parseSubscriptionEventPayload(value: unknown): RecurrenteSubscriptionEventPayload {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('Recurrente subscription event payload missing id')
  }
  const eventType = SUBSCRIPTION_EVENT_TYPES.find((t) => t === value.event_type)
  if (!eventType) {
    throw new Error('Recurrente subscription event payload has unknown event_type')
  }
  if (value.customer_email !== undefined && typeof value.customer_email !== 'string') {
    throw new Error('Recurrente subscription event payload has malformed customer_email')
  }
  return {
    event_type: eventType,
    id: value.id,
    customer_email: typeof value.customer_email === 'string' ? value.customer_email : undefined,
  }
}

/** Un header duplicado en la request real llega como string[] — para headers de firma/idempotencia solo un único valor es válido. */
function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Devuelve null si falta alguno de los tres headers de firma Svix (o llega duplicado como string[]). */
function extractSvixHeaders(req: FastifyRequest): WebhookHeaders | null {
  const svixId = singleHeaderValue(req.headers['svix-id'])
  const svixTimestamp = singleHeaderValue(req.headers['svix-timestamp'])
  const svixSignature = singleHeaderValue(req.headers['svix-signature'])
  if (!svixId || !svixTimestamp || !svixSignature) {
    return null
  }
  return { svixId, svixTimestamp, svixSignature }
}

export function registerWebhookRoutes(app: FastifyInstance, module: WebhookModule) {
  app.register(
    (webhookApp, _opts, done) => {
      // Content-type parser scoped a este plugin: preserva el raw body como string
      // para poder validar la firma Svix (HMAC sobre el body crudo, no el JSON reparseado).
      webhookApp.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, cb) => {
        cb(null, body)
      })

      // El genérico Body: string declara, para esta ruta, exactamente lo que el content-type
      // parser scoped de arriba ya garantiza en runtime — mismo patrón que las declaraciones
      // de módulo de authMiddleware.ts (tipar la garantía real en el punto donde se establece,
      // no repetir un chequeo/cast en cada uso). Un `declare module 'fastify'` global para
      // FastifyRequest.body rompería el tipado del resto de rutas, que sí reciben JSON parseado.
      webhookApp.post<{ Body: string }>('/recurrente', async (req, reply) => {
        const rawBody = req.body
        const headers = extractSvixHeaders(req)
        if (!headers) {
          return reply.status(400).send({ error: 'MISSING_SIGNATURE_HEADERS' })
        }

        const isValid = await module.paymentGatewayProvider.verifyWebhookSignature(rawBody, headers)
        if (!isValid) {
          return reply.status(400).send({ error: 'INVALID_SIGNATURE' })
        }

        const payload: unknown = JSON.parse(rawBody)
        req.log.info({ payload }, 'Recurrente webhook payload received')

        const eventType = parseEventType(payload)

        if (eventType === 'payment_intent.succeeded' || eventType === 'intent.succeeded' || eventType === 'setup_intent.succeeded') {
          await handlePaymentSucceeded(parsePaymentEventPayload(payload), module)
          return reply.status(200).send({ ok: true })
        }

        if (eventType === 'payment_intent.failed' || eventType === 'intent.failed') {
          await handlePaymentFailed(parsePaymentEventPayload(payload), module)
          return reply.status(200).send({ ok: true })
        }

        if (eventType?.startsWith('subscription.')) {
          await handleSubscriptionEvent(parseSubscriptionEventPayload(payload), module)
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
