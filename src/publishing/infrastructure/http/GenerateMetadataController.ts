import type { FastifyReply, FastifyRequest } from 'fastify'
import { MissingSubtitlesError, type GenerateYouTubeMetadataUseCase } from '../../application/use-cases/GenerateYouTubeMetadataUseCase'
import { FeatureAccessDeniedError } from '../../domain/ports/PublishingFeatureAuthorizer'
import type { VideoContext, VideoContextSubtitle } from '../../application/services/YouTubeMetadataPromptBuilder'
import type { Logger } from '../../../shared/domain/ports/Logger'
import { isRecord } from '../../../shared/domain/validation'
import { InvalidRequestError } from './httpValidation'

function isVideoContextSubtitle(value: unknown): value is VideoContextSubtitle {
  return (
    isRecord(value) &&
    typeof value.start === 'number' &&
    typeof value.end === 'number' &&
    typeof value.text === 'string'
  )
}

function parseVideoContext(value: unknown): VideoContext & { subtitles: VideoContextSubtitle[] } {
  if (!isRecord(value)) {
    throw new InvalidRequestError('"context" must be an object')
  }

  const summary = value.summary
  if (summary !== undefined && typeof summary !== 'string') {
    throw new InvalidRequestError('"context.summary" must be a string')
  }

  const detectedReason = value.detectedReason
  if (detectedReason !== undefined && typeof detectedReason !== 'string') {
    throw new InvalidRequestError('"context.detectedReason" must be a string')
  }

  const score = value.score
  if (score !== undefined && typeof score !== 'number') {
    throw new InvalidRequestError('"context.score" must be a number')
  }

  const subtitles = value.subtitles
  if (!Array.isArray(subtitles) || subtitles.length === 0 || !subtitles.every(isVideoContextSubtitle)) {
    throw new InvalidRequestError('"context.subtitles" is required and must be a non-empty array of {start,end,text}')
  }

  return { summary, detectedReason, score, subtitles }
}

interface GenerateMetadataBody {
  sourceId: string
  topic?: string
  tone?: string
  additionalInstructions?: string
  feedback?: string
  context: VideoContext & { subtitles: VideoContextSubtitle[] }
}

/** Único punto de validación de forma del body de generateMetadata — de aquí en adelante el tipo se propaga sin recastear. */
function parseGenerateMetadataBody(value: unknown): GenerateMetadataBody {
  if (!isRecord(value) || typeof value.sourceId !== 'string') {
    throw new InvalidRequestError('"sourceId" is required')
  }
  if (
    (value.topic !== undefined && typeof value.topic !== 'string') ||
    (value.tone !== undefined && typeof value.tone !== 'string') ||
    (value.additionalInstructions !== undefined && typeof value.additionalInstructions !== 'string') ||
    (value.feedback !== undefined && typeof value.feedback !== 'string')
  ) {
    throw new InvalidRequestError('"topic", "tone", "additionalInstructions" and "feedback" must be strings')
  }
  return {
    sourceId: value.sourceId,
    topic: value.topic,
    tone: value.tone,
    additionalInstructions: value.additionalInstructions,
    feedback: value.feedback,
    context: parseVideoContext(value.context),
  }
}

export class GenerateMetadataController {
  constructor(
    private readonly generateYouTubeMetadataUseCase: GenerateYouTubeMetadataUseCase,
    private readonly logger: Logger,
  ) {}

  async generateMetadata(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    try {
      const { sourceId, topic, tone, additionalInstructions, feedback, context } = parseGenerateMetadataBody(req.body)
      this.logger.info({ organizationId: req.organizationId, sourceId }, '[generateMetadata] use case starting')
      const revision = await this.generateYouTubeMetadataUseCase.execute({
        organizationId: req.organizationId,
        sourceId,
        topic,
        tone,
        additionalInstructions,
        feedback,
        context,
      })
      this.logger.info({ organizationId: req.organizationId, sourceId }, '[generateMetadata] use case completed')
      return reply.status(200).send({
        revisionId: revision.id,
        version: revision.version,
        metadata: revision.metadata,
      })
    } catch (error) {
      this.logger.error({ organizationId: req.organizationId, error: error instanceof Error ? error.message : error }, '[generateMetadata] failed')
      if (error instanceof InvalidRequestError) {
        return reply.status(400).send({ error: 'INVALID_REQUEST', message: error.message })
      }
      if (error instanceof FeatureAccessDeniedError) {
        return reply.status(403).send({ error: 'FEATURE_ACCESS_DENIED' })
      }
      if (error instanceof MissingSubtitlesError) {
        return reply.status(400).send({ error: 'MISSING_SUBTITLES' })
      }
      throw error
    }
  }
}
