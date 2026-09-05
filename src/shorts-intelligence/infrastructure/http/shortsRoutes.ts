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

const candidateSchema = {
  type: 'object',
  required: ['start', 'end', 'confidence', 'reason'],
  properties: {
    start: { type: 'number' },
    end: { type: 'number' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
} as const

const audioClipSchema = {
  type: 'object',
  required: ['start', 'end', 'audioBase64'],
  properties: {
    start: { type: 'number' },
    end: { type: 'number' },
    audioBase64: { type: 'string' },
  },
} as const

const scoreShortsBodySchema = {
  type: 'object',
  required: ['candidates', 'audioClips'],
  properties: {
    candidates: { type: 'array', items: candidateSchema },
    shortIdealJson: shortIdealJsonSchema,
    audioClips: { type: 'array', items: audioClipSchema },
  },
} as const

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

      shortsApp.post(
        '/score',
        { preHandler: authMiddleware, schema: { body: scoreShortsBodySchema } },
        (req, reply) => controller.scoreShorts(req, reply),
      )

      done()
    },
    { prefix: '/api/shorts' },
  )
}
