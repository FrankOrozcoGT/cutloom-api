import type { FastifyInstance } from 'fastify'
import type { ShortsController } from './ShortsController'
import type { createAuthMiddleware } from '../../../identity/infrastructure/http/authMiddleware'

const segmentSchema = {
  type: 'object',
  required: ['start', 'end', 'text'],
  properties: {
    start: { type: 'number' },
    end: { type: 'number' },
    text: { type: 'string' },
  },
} as const

const improveSubtitlesBodySchema = {
  type: 'object',
  required: ['segments'],
  properties: {
    segments: { type: 'array', items: segmentSchema },
    userContext: { type: 'string' },
  },
} as const

const shortIdealJsonSchema = {
  type: 'object',
  properties: {
    topic: { type: 'string' },
    targetAudience: { type: 'string' },
    targetDurationSeconds: { type: 'number' },
    tone: { type: 'string' },
    count: { type: 'number' },
  },
} as const

const detectShortsBodySchema = {
  type: 'object',
  required: ['segments'],
  properties: {
    segments: { type: 'array', items: segmentSchema },
    shortIdealJson: shortIdealJsonSchema,
  },
} as const

// Fastify's global bodyLimit (default 1MB) would reject this route's multipart body
// before @fastify/multipart's own per-file limit even applies — POST /score can carry
// up to 30 audio clips (MAX_CLIPS/MAX_CLIP_SECONDS in ScoreShortsUseCase, ~5.7MB each
// at 180s mono 16kHz), so only this route raises its own bodyLimit.
const SCORE_SHORTS_BODY_LIMIT_BYTES = 150 * 1024 * 1024

export function registerShortsRoutes(
  app: FastifyInstance,
  controller: ShortsController,
  authMiddleware: ReturnType<typeof createAuthMiddleware>,
) {
  app.register(
    (shortsApp, _opts, done) => {
      shortsApp.post(
        '/improve-subtitles',
        { preHandler: authMiddleware, schema: { body: improveSubtitlesBodySchema } },
        (req, reply) => controller.improveSubtitles(req, reply),
      )

      shortsApp.post(
        '/detect',
        { preHandler: authMiddleware, schema: { body: detectShortsBodySchema } },
        (req, reply) => controller.detectShorts(req, reply),
      )

      // multipart/form-data: sin JSON Schema de body (no aplica) — ver ShortsController.scoreShorts
      // para el parseo y validación manual del campo "payload" y los archivos de audio.
      shortsApp.post(
        '/score',
        { preHandler: authMiddleware, bodyLimit: SCORE_SHORTS_BODY_LIMIT_BYTES },
        (req, reply) => controller.scoreShorts(req, reply),
      )

      done()
    },
    { prefix: '/api/shorts' },
  )
}
