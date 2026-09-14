import type { FastifyInstance } from 'fastify'
import type { AuthController, EmailPasswordBody } from './AuthController'
import type { createAuthMiddleware } from './authMiddleware'

const emailPasswordBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string' },
    password: { type: 'string' },
  },
} as const

export function registerAuthRoutes(
  app: FastifyInstance,
  controller: AuthController,
  authMiddleware: ReturnType<typeof createAuthMiddleware>,
) {
  app.register(
    (authApp, _opts, done) => {
      authApp.post<{ Body: EmailPasswordBody }>('/register', { schema: { body: emailPasswordBodySchema } }, (req, reply) =>
        controller.register(req, reply),
      )

      authApp.post<{ Body: EmailPasswordBody }>('/login', { schema: { body: emailPasswordBodySchema } }, (req, reply) =>
        controller.login(req, reply),
      )

      authApp.get('/google/start', (req, reply) => controller.googleStart(req, reply))

      authApp.get('/google/callback', (req, reply) => controller.googleCallback(req, reply))

      authApp.post('/logout', (req, reply) => controller.logout(req, reply))

      authApp.post('/refresh', (req, reply) => controller.refresh(req, reply))

      authApp.get('/me', { preHandler: authMiddleware }, (req, reply) => controller.me(req, reply))

      done()
    },
    { prefix: '/api/auth' },
  )
}
