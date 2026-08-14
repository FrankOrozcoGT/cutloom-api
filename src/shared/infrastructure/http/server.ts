import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { db } from '../db/client'
import { buildAuthModule } from '../../../identity/infrastructure/composition/authComposition'
import { registerAuthRoutes } from '../../../identity/infrastructure/http/authRoutes'

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

  const { controller: authController, authMiddleware } = buildAuthModule(db)
  registerAuthRoutes(app, authController, authMiddleware)

  app.get('/health', () => ({ status: 'ok' }))

  return app
}
