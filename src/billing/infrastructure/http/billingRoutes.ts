import type { FastifyInstance } from 'fastify'
import type { BillingController, CheckoutReturnQuery, PlanIdBody, TopUpCreditsBody } from './BillingController'
import type { createAuthMiddleware } from '../../../identity/infrastructure/http/authMiddleware'

const checkoutBodySchema = {
  type: 'object',
  required: ['planId'],
  properties: {
    planId: { type: 'string' },
  },
} as const

// GET con querystring (no multipart) — JSON Schema sí aplica normal acá, a diferencia de los
// endpoints multipart de publishing/shorts (Fastify no valida schema contra multipart/form-data,
// ver github.com/fastify/fastify/issues/4127: el body ahí llega como stream de parts, no como
// objeto plano, así que no hay nada que el validador de schema pueda revisar todavía).
const checkoutReturnQuerySchema = {
  type: 'object',
  properties: {
    result: { type: 'string' },
    flow: { type: 'string' },
  },
} as const

const topUpBodySchema = {
  type: 'object',
  required: ['amountInCents'],
  properties: {
    amountInCents: { type: 'number' },
    currency: { type: 'string' },
  },
} as const

export function registerBillingRoutes(
  app: FastifyInstance,
  controller: BillingController,
  authMiddleware: ReturnType<typeof createAuthMiddleware>,
) {
  app.register(
    (billingApp, _opts, done) => {
      // Pricing page: pública, sin authMiddleware — se necesita ver los planes antes de loguearse.
      billingApp.get('/plans', (req, reply) => controller.listPlans(req, reply))

      // Puente de retorno del checkout alojado (ver CreateCheckoutSessionUseCase) — pública,
      // sin authMiddleware: es la navegación GET de vuelta desde app.recurrente.com.
      billingApp.get<{ Querystring: CheckoutReturnQuery }>(
        '/checkout-return',
        { schema: { querystring: checkoutReturnQuerySchema } },
        (req, reply) => controller.checkoutReturn(req, reply),
      )

      billingApp.post<{ Body: PlanIdBody }>(
        '/checkout',
        { preHandler: authMiddleware, schema: { body: checkoutBodySchema } },
        (req, reply) => controller.checkout(req, reply),
      )

      billingApp.post('/cancel', { preHandler: authMiddleware }, (req, reply) => controller.cancel(req, reply))

      billingApp.post<{ Body: PlanIdBody }>(
        '/change-plan',
        { preHandler: authMiddleware, schema: { body: checkoutBodySchema } },
        (req, reply) => controller.changePlan(req, reply),
      )

      billingApp.post<{ Body: TopUpCreditsBody }>(
        '/credits/topup',
        { preHandler: authMiddleware, schema: { body: topUpBodySchema } },
        (req, reply) => controller.topUpCredits(req, reply),
      )

      billingApp.get('/subscription', { preHandler: authMiddleware }, (req, reply) =>
        controller.getSubscription(req, reply),
      )

      billingApp.get('/credits/balance', { preHandler: authMiddleware }, (req, reply) =>
        controller.getCreditBalance(req, reply),
      )

      done()
    },
    { prefix: '/api/billing' },
  )
}
