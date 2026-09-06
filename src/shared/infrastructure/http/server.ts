import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { db } from '../db/client'
import { buildAuthModule } from '../../../identity/infrastructure/composition/authComposition'
import { registerAuthRoutes } from '../../../identity/infrastructure/http/authRoutes'
import { buildBillingModule } from '../../../billing/infrastructure/composition/billingComposition'
import { registerBillingRoutes } from '../../../billing/infrastructure/http/billingRoutes'
import { registerWebhookRoutes } from '../../../billing/infrastructure/http/webhookRoutes'
import { registerDonationRoutes } from '../../../billing/infrastructure/http/donationRoutes'
import { buildShortsModule } from '../../../shorts-intelligence/infrastructure/composition/shortsComposition'
import { registerShortsRoutes } from '../../../shorts-intelligence/infrastructure/http/shortsRoutes'

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
  // Límites alineados con ScoreShortsUseCase (MAX_CLIPS=30, MAX_CLIP_SECONDS=180 — un WAV
  // mono 16kHz de 180s pesa ~5.7MB, 10MB deja margen sin abrir la puerta a payloads arbitrarios).
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 30 } })

  const billingModule = buildBillingModule(db)

  const { controller: authController, authMiddleware } = buildAuthModule(db, {
    findByOrganizationId: (organizationId) =>
      billingModule.entitlementRepository.findByOrganizationId(organizationId),
  })
  registerAuthRoutes(app, authController, authMiddleware)

  registerBillingRoutes(app, billingModule.controller, authMiddleware)
  registerWebhookRoutes(app, billingModule.webhookModule)
  registerDonationRoutes(app, billingModule.createDonationUseCase, billingModule.donationRoutesConfig)

  const shortsModule = buildShortsModule(db, {
    requireEntitlement: (input) => billingModule.authorizeFeatureUsageUseCase.requireEntitlement(input),
  })
  registerShortsRoutes(app, shortsModule.controller, authMiddleware)

  app.get('/health', () => ({ status: 'ok' }))

  return app
}
