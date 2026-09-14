import type { FastifyInstance } from 'fastify'
import type { PublishingController } from './PublishingController'
import type { createAuthMiddleware } from '../../../identity/infrastructure/http/authMiddleware'
import { BULK_UPLOAD_BODY_LIMIT_BYTES } from '../../application/use-cases/BulkUploadToYouTubeUseCase'

export function registerPublishingRoutes(
  app: FastifyInstance,
  controller: PublishingController,
  authMiddleware: ReturnType<typeof createAuthMiddleware>,
) {
  app.register(
    (publishingApp, _opts, done) => {
      publishingApp.get(
        '/youtube/auth/start',
        { preHandler: authMiddleware },
        (req, reply) => controller.youtubeAuthStart(req, reply),
      )

      // Navegación top-level del navegador (redirect de Google) — no lleva header
      // Authorization, así que no puede pasar por authMiddleware. organizationId viaja
      // en cookie httpOnly seteada en /auth/start (ver PublishingController).
      publishingApp.get('/youtube/auth/callback', (req, reply) => controller.youtubeAuthCallback(req, reply))

      // Sin JSON Schema de body: la validación de forma vive en PublishingController.parseGenerateMetadataBody,
      // único punto de verdad (evita mantener el mismo shape duplicado en dos lugares).
      publishingApp.post(
        '/youtube/generate-metadata',
        { preHandler: authMiddleware },
        (req, reply) => controller.generateMetadata(req, reply),
      )

      // multipart/form-data: sin JSON Schema de body (no aplica) — ver PublishingController.bulkUpload.
      publishingApp.post(
        '/youtube/bulk-upload',
        { preHandler: authMiddleware, bodyLimit: BULK_UPLOAD_BODY_LIMIT_BYTES },
        (req, reply) => controller.bulkUpload(req, reply),
      )

      done()
    },
    { prefix: '/api/publishing' },
  )
}
