import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PlatformOAuthController } from './PlatformOAuthController'
import type { PlanBulkUploadController } from './PlanBulkUploadController'
import type { GenerateMetadataController } from './GenerateMetadataController'
import type { TusBulkUploadHandler } from './TusBulkUploadHandler'
import type { createAuthMiddleware } from '../../../identity/infrastructure/http/authMiddleware'
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

const TUS_UPLOAD_PATH = '/api/publishing/bulk-upload/files'

/**
 * Rutas de publishing bajo /api/publishing. Separadas por responsabilidad:
 * PlatformOAuthController (conexión de cuentas + capabilities), PlanBulkUploadController
 * (declara el plan de un bulk, sin archivos), TusBulkUploadHandler (protocolo tus para subir
 * cada binario, enganchado a BulkUploadOrchestrator por eventos — ver ese archivo),
 * GenerateMetadataController (IA). bulk-upload ya no toma :platform: un mismo bulk puede
 * publicarse a varias plataformas a la vez (ver PlanBulkUploadUseCase).
 */
export function registerPublishingRoutes(
  app: FastifyInstance,
  oauthController: PlatformOAuthController,
  planBulkUploadController: PlanBulkUploadController,
  generateMetadataController: GenerateMetadataController,
  tusBulkUploadHandler: TusBulkUploadHandler,
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

      // Solo el plan (JSON, sin binarios) — devuelve una URL tus por sourceId. El binario se
      // sube después, por separado, a TUS_UPLOAD_PATH (ver sub-scope más abajo). Resume un bulk
      // activo existente si ya hay uno para el mismo seriesId (ver PlanBulkUploadUseCase).
      publishingApp.post(
        '/bulk-upload',
        { preHandler: authMiddleware },
        (req, reply) => planBulkUploadController.planBulkUpload(req, reply),
      )

      // Cancelación explícita a pedido del frontend — distinta de la expiración automática de 7
      // días (ver ExpireStaleBulkUploadsUseCase). El frontend decide cuándo usarla.
      publishingApp.delete(
        '/bulk-upload/:seriesId',
        { preHandler: authMiddleware },
        (req, reply) => planBulkUploadController.cancelBulkUpload(req, reply),
      )

      // Estado real del bulk + cada archivo — para que el frontend decida con datos reales si
      // continuar o cancelar, sin tener que inferirlo de un código de error.
      publishingApp.get(
        '/bulk-upload/:seriesId/status',
        { preHandler: authMiddleware },
        (req, reply) => planBulkUploadController.getBulkUploadStatus(req, reply),
      )

      // A pedido explícito del frontend, desde la vista de un bulk ya terminado de subir —
      // reintenta solo los PublishedVideo Failed de ese bulk específico (ver
      // RetryFailedPublicationsUseCase). bulkUploadId, no seriesId: el usuario ya está viendo
      // un bulk puntual, no hace falta resolver "el bulk activo de esta serie".
      publishingApp.post(
        '/bulk-upload/:bulkUploadId/retry-failed',
        { preHandler: authMiddleware },
        (req, reply) => planBulkUploadController.retryFailedPublications(req, reply),
      )

      publishingApp.get(
        '/tiktok/capabilities',
        { preHandler: authMiddleware },
        (req, reply) => oauthController.tiktokCapabilities(req, reply),
      )

      // Sub-scope aislado solo para el webhook: este content-type parser (raw string, para
      // poder validar la firma TikTok-Signature con HMAC sobre el body crudo) no debe afectar
      // al resto de las rutas de este plugin, que necesitan el JSON ya parseado por el parser
      // default de Fastify.
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

  // Fuera del scope de /api/publishing: el protocolo tus define sus propios content-type
  // (application/offset+octet-stream) y verbos (PATCH/HEAD con headers Tus-*) — @tus/server
  // necesita manejar el request/response crudos (req.raw/reply.raw) sin que ningún parser de
  // Fastify (JSON, multipart) toque el body antes. Registrado en un scope propio, sin
  // addContentTypeParser ni bodyLimit global que puedan interferir.
  app.register(
    (tusApp, _opts, tusDone) => {
      // Pass-through: NO consumir el body acá — @tus/server necesita leer el stream crudo
      // directo de request.raw (PATCH con Content-Type application/offset+octet-stream, entre
      // otros). Sin este parser "vacío" registrado para '*', el parser default de Fastify
      // consumiría el stream antes de que @tus/server pueda leerlo.
      tusApp.addContentTypeParser('*', (_req, _payload, done) => done(null))
      tusBulkUploadHandler.registerRoutes(tusApp, TUS_UPLOAD_PATH)
      tusDone()
    },
  )
}
