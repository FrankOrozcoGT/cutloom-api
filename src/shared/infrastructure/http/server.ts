import { mkdirSync } from 'node:fs'
import Fastify from 'fastify'
import pino from 'pino'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { db } from '../db/client'
import { readEnv } from '../config/readEnv'
import { corsOrigins } from '../config/corsOrigins'
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
import { DrizzlePlatformOAuthTokenRepository } from '../../../publishing/infrastructure/repositories/DrizzlePlatformOAuthTokenRepository'
import { DrizzlePlatformAccountRepository } from '../../../publishing/infrastructure/repositories/DrizzlePlatformAccountRepository'
import { DrizzleActivePlatformAccountRepository } from '../../../publishing/infrastructure/repositories/DrizzleActivePlatformAccountRepository'
import { VideoPlatform } from '../../../publishing/domain/entities/PublishedVideo'
import { DrizzleNotificationRepository } from '../db/DrizzleNotificationRepository'
import { NotificationController } from './NotificationController'
import { registerNotificationRoutes } from './notificationRoutes'
import { ListNotificationsUseCase } from '../../application/use-cases/ListNotificationsUseCase'
import { MarkNotificationReadUseCase } from '../../application/use-cases/MarkNotificationReadUseCase'
import { InMemoryNotificationPublisher } from './InMemoryNotificationPublisher'
import { UsageEventFeature } from '../../../shorts-intelligence/domain/ports/UsageEventRepository'


type RequireEntitlement = (input: { organizationId: string; feature: string; amount: number }) => Promise<void>

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
  // En dev, además de stdout (que se pierde si el proceso o la máquina mueren de golpe, ej. un
  // OOM), se escribe a un archivo en disco — así el log del momento exacto del colapso persiste
  // y se puede revisar después, en vez de depender de que la terminal siga viva para leerlo.
  // pino.destination no crea el directorio padre solo — sin mkdirSync previo, falla con ENOENT
  // y deja el stream sin inicializar ("sonic boom is not ready yet") en el primer log emitido.
  if (process.env.NODE_ENV !== 'production') {
    mkdirSync('./logs', { recursive: true })
  }
  const devLogFile = process.env.NODE_ENV === 'production' ? undefined : pino.destination({ dest: './logs/backend.log', sync: false })
  const app = Fastify({
    logger: devLogFile
      ? { level: logLevel, stream: pino.multistream([{ stream: process.stdout }, { stream: devLogFile }]) }
      : { level: logLevel },
  })

  app.register(cors, {
    origin: corsOrigins(),
    credentials: true,
    // El frontend necesita leer el header Location del redirect 302 de /youtube/auth/start
    // (ej. para abrirlo en popup en vez de dejar que el navegador redirija solo) — sin esto,
    // @fastify/cors no expone headers custom por default en una respuesta cross-origin.
    exposedHeaders: ['Location'],
    // Default de @fastify/cors (GET,HEAD,POST) no alcanza para las rutas tus de bulk-upload
    // (PATCH para subir chunks, DELETE para abortar) — @fastify/cors intercepta el preflight de
    // TODAS las rutas antes de que @tus/server pueda responder el suyo propio, así que su propia
    // config de allowedOrigins/allowedHeaders (ver TusBulkUploadHandler) nunca llega a aplicarse
    // para el método. El resto de las rutas (JSON) nunca usa PATCH/DELETE, así que ampliar esto
    // acá no habilita nada indebido en ellas.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
  app.register(cookie)
  // Límites alineados con ScoreShortsUseCase (MAX_CLIPS=30, MAX_CLIP_SECONDS=180 — un WAV
  // mono 16kHz de 180s pesa ~5.7MB, 10MB deja margen sin abrir la puerta a payloads arbitrarios).
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 30 } })

  const billingModule = buildBillingModule(db)
  const platformOAuthTokenRepository = new DrizzlePlatformOAuthTokenRepository(db)
  const platformAccountRepository = new DrizzlePlatformAccountRepository(db)
  const activePlatformAccountRepository = new DrizzleActivePlatformAccountRepository(db)
  const notificationRepository = new DrizzleNotificationRepository(db)
  const notificationPublisher = new InMemoryNotificationPublisher()
  // Único dominio base del backend — todos los redirect_uri de OAuth (Google/YouTube/TikTok)
  // se construyen a partir de esta variable, en vez de tener una env var suelta por proveedor
  // (ver buildAuthModule/buildPublishingModule).
  const apiBaseUrl = readEnv('API_BASE_URL', 'http://localhost:3000')

  const { controller: authController, authMiddleware, sseAuthMiddleware } = buildAuthModule(
    db,
    {
      findByOrganizationId: async (organizationId) => {
        const features = await billingModule.entitlementRepository.findActiveFeaturesByOrganizationId(organizationId)
        return features.map(({ feature, planBalance }) => ({ feature, active: true as const, planBalance }))
      },
    },
    {
      getStatus: async (organizationId) => {
        const accountId = await activePlatformAccountRepository.findActivePlatformAccountId(organizationId, VideoPlatform.YouTube)
        const account = accountId ? await platformAccountRepository.findById(accountId) : null
        return { connected: account !== null, platformAccountInfo: account?.platformAccountInfo ?? null }
      },
    },
    {
      getStatus: async (organizationId) => {
        const accountId = await activePlatformAccountRepository.findActivePlatformAccountId(organizationId, VideoPlatform.TikTok)
        const account = accountId ? await platformAccountRepository.findById(accountId) : null
        return { connected: account !== null, platformAccountInfo: account?.platformAccountInfo ?? null }
      },
    },
    {
      findByOrganizationId: async (organizationId) => {
        const { balance } = await billingModule.getCreditBalanceUseCase.execute(organizationId)
        return balance
      },
    },
    apiBaseUrl,
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
    {
      record: (input) =>
        shortsModule.usageEventService.record({
          organizationId: input.organizationId,
          feature: input.feature,
          provider: input.provider,
          model: input.model,
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          cost: null,
          metadata: { feature: UsageEventFeature.GenerateYouTubeMetadata },
        }),
    },
    app.log,
    platformOAuthTokenRepository,
    platformAccountRepository,
    activePlatformAccountRepository,
    notificationRepository,
    notificationPublisher,
    apiBaseUrl,
  )
  registerPublishingRoutes(
    app,
    publishingModule.oauthController,
    publishingModule.planBulkUploadController,
    publishingModule.generateMetadataController,
    publishingModule.tusBulkUploadHandler,
    authMiddleware,
    publishingModule.handleTikTokWebhookUseCase,
    readEnv('TIKTOK_CLIENT_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-placeholder'),
  )

  const notificationController = new NotificationController(
    new ListNotificationsUseCase(notificationRepository),
    new MarkNotificationReadUseCase(notificationRepository),
    notificationPublisher,
    corsOrigins(),
  )
  registerNotificationRoutes(app, notificationController, authMiddleware, sseAuthMiddleware)

  app.get('/health', () => ({ status: 'ok' }))

  Bun.cron('0 * * * *', () => {
    billingModule.expireCancelledSubscriptionsUseCase.execute().catch((error: unknown) => {
      app.log.error({ error }, 'expireCancelledSubscriptionsUseCase failed')
    })
  })

  // Diario (no cada hora como el resto): el umbral real es de 7 días sin actividad (ver
  // ExpireStaleBulkUploadsUseCase), una cadencia horaria no aportaría nada.
  Bun.cron('0 3 * * *', () => {
    publishingModule.expireStaleBulkUploadsUseCase.execute().catch((error: unknown) => {
      app.log.error({ error }, 'expireStaleBulkUploadsUseCase failed')
    })
  })

  Bun.cron('0 * * * *', () => {
    publishingModule.publishScheduledTikTokVideosUseCase.execute().catch((error: unknown) => {
      app.log.error({ error }, 'publishScheduledTikTokVideosUseCase failed')
    })
  })

  return app
}
