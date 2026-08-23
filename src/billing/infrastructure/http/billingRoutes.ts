import type { FastifyInstance } from 'fastify'
import type { BillingController } from './BillingController'
import type { createAuthMiddleware } from '../../../identity/infrastructure/http/authMiddleware'

const checkoutBodySchema = {
  type: 'object',
  required: ['planId'],
  properties: {
    planId: { type: 'string' },
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
      billingApp.get('/checkout-return', (req, reply) => controller.checkoutReturn(req, reply))

      billingApp.post(
        '/checkout',
        { preHandler: authMiddleware, schema: { body: checkoutBodySchema } },
        (req, reply) => controller.checkout(req, reply),
      )

      billingApp.post('/cancel', { preHandler: authMiddleware }, (req, reply) => controller.cancel(req, reply))

      billingApp.post(
        '/change-plan',
        { preHandler: authMiddleware, schema: { body: checkoutBodySchema } },
        (req, reply) => controller.changePlan(req, reply),
      )

      billingApp.post(
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
