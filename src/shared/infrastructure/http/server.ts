import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { db } from '../db/client'
import { buildAuthModule } from '../../../identity/infrastructure/composition/authComposition'
import { registerAuthRoutes } from '../../../identity/infrastructure/http/authRoutes'
import { buildBillingModule } from '../../../billing/infrastructure/composition/billingComposition'
import { registerBillingRoutes } from '../../../billing/infrastructure/http/billingRoutes'
import { registerWebhookRoutes } from '../../../billing/infrastructure/http/webhookRoutes'
import { registerDonationRoutes } from '../../../billing/infrastructure/http/donationRoutes'

function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS
  if (!raw) {
    return ['http://localhost:5173']
  }
  return raw.split(',').map((origin) => origin.trim())
}

export function buildServer() {
  const app = Fastify({ logger: true })

  app.register(cors, {
    origin: corsOrigins(),
    credentials: true,
  })
  app.register(cookie)

  const billingModule = buildBillingModule(db)

  const { controller: authController, authMiddleware } = buildAuthModule(db, {
    findByOrganizationId: (organizationId) =>
      billingModule.entitlementRepository.findByOrganizationId(organizationId),
  })
  registerAuthRoutes(app, authController, authMiddleware)

  registerBillingRoutes(app, billingModule.controller, authMiddleware)
  registerWebhookRoutes(app, billingModule.webhookModule)
  registerDonationRoutes(app, billingModule.createDonationUseCase, billingModule.donationRoutesConfig)

  app.get('/health', () => ({ status: 'ok' }))

  return app
}
