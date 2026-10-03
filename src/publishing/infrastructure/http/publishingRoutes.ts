import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PlatformOAuthController } from './PlatformOAuthController'
import type { BulkUploadController } from './BulkUploadController'
import type { GenerateMetadataController } from './GenerateMetadataController'
import type { createAuthMiddleware } from '../../../identity/infrastructure/http/authMiddleware'
import { BULK_UPLOAD_BODY_LIMIT_BYTES } from '../../application/use-cases/BulkUploadVideoUseCase'
import type { HandleTikTokWebhookUseCase } from '../../application/use-cases/HandleTikTokWebhookUseCase'
import { verifyTikTokWebhookSignature } from './verifyTikTokWebhookSignature'
import { isRecord } from '../../../shared/domain/validation'

/** Único punto de validación de forma del payload del webhook — el shape real se confirma
 * contra el payload logueado en el primer evento que llegue (ver handler de abajo). */
function parseTikTokWebhookPayload(value: unknown): { event: string; publishId: string } | null {
  if (!isRecord(value) || typeof value.event !== 'string') return null
  const content = isRecord(value.content) ? value.content : value
  const publishId = typeof content.publish_id === 'string' ? content.publish_id : undefined
  if (!publishId) return null
  return { event: value.event, publishId }
}

/** Un header duplicado llega como string[] — para la firma solo un único valor es válido. */
function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Rutas de publishing bajo /api/publishing. Separadas por responsabilidad en tres controllers
 * (PlatformOAuthController: conexión de cuentas + capabilities; BulkUploadController: subida de
 * videos; GenerateMetadataController: generación de metadata con IA) que comparten el prefix
 * HTTP pero no tienen relación de dominio entre sí — solo generate-metadata y tiktok/capabilities
 * no toman :platform (metadata es IA compartida por sourceId; capabilities es viabilidad
 * específica de TikTok). El webhook solo lo usa TikTok (YouTube no tiene publicación asíncrona
 * que notificar).
 */
export function registerPublishingRoutes(
  app: FastifyInstance,
  oauthController: PlatformOAuthController,
  bulkUploadController: BulkUploadController,
  generateMetadataController: GenerateMetadataController,
  authMiddleware: ReturnType<typeof createAuthMiddleware>,
  handleTikTokWebhookUseCase: HandleTikTokWebhookUseCase,
  tikTokClientSecret: string,
) {
  app.register(
    (publishingApp, _opts, done) => {
      publishingApp.get(
        '/:platform/auth/start',
        { preHandler: authMiddleware },
        (req, reply) => oauthController.oauthStart(req, reply),
      )

      // Navegación top-level del navegador (redirect del proveedor OAuth) — no lleva header
      // Authorization, así que no puede pasar por authMiddleware. organizationId viaja en
      // cookie httpOnly seteada en /auth/start (ver PlatformOAuthController).
      publishingApp.get('/:platform/auth/callback', (req, reply) => oauthController.oauthCallback(req, reply))

      // Sin JSON Schema de body: la validación de forma vive en GenerateMetadataController,
      // único punto de verdad (evita mantener el mismo shape duplicado en dos lugares). Genera
      // una ContentRevision compartida por cualquier plataforma — no toma :platform.
      publishingApp.post(
        '/youtube/generate-metadata',
        { preHandler: authMiddleware },
        (req, reply) => generateMetadataController.generateMetadata(req, reply),
      )

      // multipart/form-data: sin JSON Schema de body (no aplica) — ver BulkUploadController.
      // Sirve tanto "publicar ahora" como "calendarizar": BulkUploadVideoUseCase decide según
      // el resultado de ScheduleUploadPlanService y si la plataforma soporta scheduling nativo.
      publishingApp.post(
        '/:platform/bulk-upload',
        { preHandler: authMiddleware, bodyLimit: BULK_UPLOAD_BODY_LIMIT_BYTES },
        (req, reply) => bulkUploadController.bulkUpload(req, reply),
      )

      publishingApp.get(
        '/tiktok/capabilities',
        { preHandler: authMiddleware },
        (req, reply) => oauthController.tiktokCapabilities(req, reply),
      )

      // Sub-scope aislado solo para el webhook: este content-type parser (raw string, para
      // poder validar la firma TikTok-Signature con HMAC sobre el body crudo) no debe afectar
      // al resto de las rutas de este plugin (generate-metadata, bulk-upload), que necesitan el
      // JSON ya parseado por el parser default de Fastify.
      publishingApp.register(
        (webhookApp, _opts, webhookDone) => {
          webhookApp.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, cb) => {
            cb(null, body)
          })

          webhookApp.post<{ Body: string }>('/tiktok/webhook', async (req: FastifyRequest<{ Body: string }>, reply) => {
            const rawBody = req.body
            const signatureHeader = singleHeaderValue(req.headers['tiktok-signature'])
            if (!signatureHeader) {
              return reply.status(400).send({ error: 'MISSING_SIGNATURE_HEADER' })
            }
            if (!verifyTikTokWebhookSignature(rawBody, signatureHeader, tikTokClientSecret)) {
              return reply.status(400).send({ error: 'INVALID_SIGNATURE' })
            }

            const payload: unknown = JSON.parse(rawBody)
            // Primer evento real: confirmar acá el shape exacto (nombre del evento, campo del id)
            // contra lo que TikTok manda de verdad para la Content Posting API — la doc pública no
            // lo documenta con certeza para este producto específico (ver HandleTikTokWebhookUseCase).
            req.log.info({ payload }, 'TikTok webhook payload received')

            const parsed = parseTikTokWebhookPayload(payload)
            if (!parsed) {
              // Shape no reconocido — no es un error del caller (TikTok ya lo mandó), solo no
              // coincide con lo que esperábamos: se acusa recibo igual para que TikTok no reintente.
              return reply.status(200).send({ ok: true })
            }

            await handleTikTokWebhookUseCase.execute(parsed)
            return reply.status(200).send({ ok: true })
          })

          webhookDone()
        },
      )

      done()
    },
    { prefix: '/api/publishing' },
  )
}
