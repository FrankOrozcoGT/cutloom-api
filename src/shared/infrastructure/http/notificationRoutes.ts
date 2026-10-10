import type { FastifyInstance } from 'fastify'
import type { NotificationController } from './NotificationController'
import type { createAuthMiddleware } from '../../../identity/infrastructure/http/authMiddleware'
import type { createSseAuthMiddleware } from '../../../identity/infrastructure/http/sseAuthMiddleware'

export function registerNotificationRoutes(
  app: FastifyInstance,
  controller: NotificationController,
  authMiddleware: ReturnType<typeof createAuthMiddleware>,
  sseAuthMiddleware: ReturnType<typeof createSseAuthMiddleware>,
) {
  app.register(
    (notificationsApp, _opts, done) => {
      notificationsApp.get('/', { preHandler: authMiddleware }, (req, reply) => controller.list(req, reply))
      notificationsApp.post('/:id/read', { preHandler: authMiddleware }, (req, reply) => controller.markRead(req, reply))
      // EventSource no manda header Authorization — autenticado por cookie httpOnly propia (ver sseAuthMiddleware), no por Bearer.
      notificationsApp.get('/stream', { preHandler: sseAuthMiddleware }, (req, reply) => controller.stream(req, reply))

      done()
    },
    { prefix: '/api/notifications' },
  )
}
