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
import { FeatureAccessDeniedError as BillingFeatureAccessDeniedError } from '../../../billing/application/use-cases/AuthorizeFeatureUsageUseCase'
import { buildShortsModule } from '../../../shorts-intelligence/infrastructure/composition/shortsComposition'
import { registerShortsRoutes } from '../../../shorts-intelligence/infrastructure/http/shortsRoutes'
import { FeatureAccessDeniedError as ShortsFeatureAccessDeniedError } from '../../../shorts-intelligence/domain/ports/FeatureUsageAuthorizer'
import { buildPublishingModule } from '../../../publishing/infrastructure/composition/publishingComposition'
import { registerPublishingRoutes } from '../../../publishing/infrastructure/http/publishingRoutes'
import { FeatureAccessDeniedError as PublishingFeatureAccessDeniedError } from '../../../publishing/domain/ports/PublishingFeatureAuthorizer'
import { DrizzleYouTubeOAuthTokenRepository } from '../../../publishing/infrastructure/repositories/DrizzleYouTubeOAuthTokenRepository'

function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS
  if (!raw) {
    return ['http://localhost:5173']
  }
  return raw.split(',').map((origin) => origin.trim())
}

type RequireEntitlement = (input: { organizationId: string; feature: string }) => Promise<void>

/** Traduce el `FeatureAccessDeniedError` genérico de billing al error de dominio propio del
 * bounded context llamador, para que cada contexto solo conozca sus propias clases de error. */
function adaptRequireEntitlement<E extends Error>(
  requireEntitlement: RequireEntitlement,
  ErrorClass: new (feature: string) => E,
): RequireEntitlement {
  return async (input) => {
    try {
      await requireEntitlement(input)
    } catch (error) {
      if (error instanceof BillingFeatureAccessDeniedError) {
        throw new ErrorClass(input.feature)
      }
      throw error
    }
  }
}

export function buildServer() {
  // 'info' (default de Fastify) loguea cada request completa — volumen alto en producción,
  // sumado a que hoy no hay agregador de logs externo (solo stdout + rotación de Docker, ver
  // docker-compose.yml), así que se reduce a 'warn' fuera de dev para no saturar el disco.
  const logLevel = process.env.NODE_ENV === 'production' ? 'warn' : 'info'
  const app = Fastify({ logger: { level: logLevel } })

  app.register(cors, {
    origin: corsOrigins(),
    credentials: true,
    // El frontend necesita leer el header Location del redirect 302 de /youtube/auth/start
    // (ej. para abrirlo en popup en vez de dejar que el navegador redirija solo) — sin esto,
    // @fastify/cors no expone headers custom por default en una respuesta cross-origin.
    exposedHeaders: ['Location'],
  })
  app.register(cookie)
  // Límites alineados con ScoreShortsUseCase (MAX_CLIPS=30, MAX_CLIP_SECONDS=180 — un WAV
  // mono 16kHz de 180s pesa ~5.7MB, 10MB deja margen sin abrir la puerta a payloads arbitrarios).
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 30 } })

  const billingModule = buildBillingModule(db)
  const youTubeOAuthTokenRepository = new DrizzleYouTubeOAuthTokenRepository(db)

  const { controller: authController, authMiddleware } = buildAuthModule(
    db,
    {
      findByOrganizationId: async (organizationId) => {
        const features = await billingModule.entitlementRepository.findActiveFeaturesByOrganizationId(organizationId)
        return features.map(({ feature }) => ({ feature, active: true as const }))
      },
    },
    {
      getStatus: async (organizationId) => {
        const token = await youTubeOAuthTokenRepository.findByOrganizationId(organizationId)
        return {
          connected: token !== null,
          googleEmail: token?.googleEmail ?? null,
          channelTitle: token?.channelTitle ?? null,
        }
      },
    },
  )
  registerAuthRoutes(app, authController, authMiddleware)

  registerBillingRoutes(app, billingModule.controller, authMiddleware)
  registerWebhookRoutes(app, billingModule.webhookModule)
  registerDonationRoutes(app, billingModule.createDonationUseCase, billingModule.donationRoutesConfig)

  const shortsModule = buildShortsModule(
    db,
    {
      requireEntitlement: adaptRequireEntitlement(
        billingModule.authorizeFeatureUsageUseCase.requireEntitlement.bind(billingModule.authorizeFeatureUsageUseCase),
        ShortsFeatureAccessDeniedError,
      ),
    },
    app.log,
  )
  registerShortsRoutes(app, shortsModule.controller, authMiddleware)

  const publishingModule = buildPublishingModule(
    db,
    {
      requireEntitlement: adaptRequireEntitlement(
        billingModule.authorizeFeatureUsageUseCase.requireEntitlement.bind(billingModule.authorizeFeatureUsageUseCase),
        PublishingFeatureAccessDeniedError,
      ),
    },
    app.log,
    youTubeOAuthTokenRepository,
  )
  registerPublishingRoutes(app, publishingModule.controller, authMiddleware)

  app.get('/health', () => ({ status: 'ok' }))

  Bun.cron('0 * * * *', () => {
    billingModule.expireCancelledSubscriptionsUseCase.execute().catch((error: unknown) => {
      app.log.error({ error }, 'expireCancelledSubscriptionsUseCase failed')
    })
  })

  Bun.cron('0 * * * *', () => {
    publishingModule.expireStaleUploadingUseCase.execute().catch((error: unknown) => {
      app.log.error({ error }, 'expireStaleUploadingUseCase failed')
    })
  })

  return app
}
