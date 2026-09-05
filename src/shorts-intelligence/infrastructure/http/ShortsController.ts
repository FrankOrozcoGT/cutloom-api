import type { FastifyReply, FastifyRequest } from 'fastify'
import { FeatureAccessDeniedError } from '../../../billing/application/use-cases/AuthorizeFeatureUsageUseCase'
import {
  EmptySegmentsError,
  SubtitlesLlmFailedError,
  type ImproveSubtitlesUseCase,
} from '../../application/use-cases/ImproveSubtitlesUseCase'
import {
  EmptySegmentsError as DetectShortsEmptySegmentsError,
  ShortsLlmFailedError,
  type DetectedShortCandidate,
  type DetectShortsUseCase,
} from '../../application/use-cases/DetectShortsUseCase'
import {
  EmptyCandidatesError,
  InvalidAudioSegmentError,
  TooManyClipsError,
  type AudioClipForShort,
  type ScoreShortsUseCase,
} from '../../application/use-cases/ScoreShortsUseCase'
import type { ShortIdealJson } from '../../application/services/ShortPromptBuilder'
import type { SubtitleSegmentInput } from '../../domain/ports/ShortsIntelligencePort'

interface ImproveSubtitlesBody {
  segments: SubtitleSegmentInput[]
  userContext?: string
}

interface DetectShortsBody {
  segments: SubtitleSegmentInput[]
  shortIdealJson?: ShortIdealJson
}

interface ScoreShortsBody {
  candidates: DetectedShortCandidate[]
  shortIdealJson?: ShortIdealJson
  audioClips: AudioClipForShort[]
}

export class ShortsController {
  constructor(
    private readonly improveSubtitlesUseCase: ImproveSubtitlesUseCase,
    private readonly detectShortsUseCase: DetectShortsUseCase,
    private readonly scoreShortsUseCase: ScoreShortsUseCase,
  ) {}

  async improveSubtitles(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    const body = req.body as ImproveSubtitlesBody

    try {
      const result = await this.improveSubtitlesUseCase.execute({
        organizationId: req.organizationId,
        segments: body.segments,
        userContext: body.userContext,
      })
      return reply.status(200).send({
        summary: result.summary,
        correctedSubtitles: result.correctedSubtitles.map((c) => c.toJSON()),
      })
    } catch (error) {
      if (error instanceof EmptySegmentsError) {
        return reply.status(400).send({ error: 'EMPTY_SEGMENTS' })
      }
      if (error instanceof FeatureAccessDeniedError) {
        return reply.status(403).send({ error: 'SHORTS_ACCESS_DENIED' })
      }
      if (error instanceof SubtitlesLlmFailedError) {
        return reply.status(502).send({ error: 'SUBTITLES_LLM_FAILED' })
      }
      throw error
    }
  }

  async detectShorts(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    const body = req.body as DetectShortsBody

    try {
      const result = await this.detectShortsUseCase.execute({
        organizationId: req.organizationId,
        segments: body.segments,
        shortIdealJson: body.shortIdealJson,
      })
      return reply.status(200).send(result)
    } catch (error) {
      if (error instanceof DetectShortsEmptySegmentsError) {
        return reply.status(400).send({ error: 'EMPTY_SEGMENTS' })
      }
      if (error instanceof FeatureAccessDeniedError) {
        return reply.status(403).send({ error: 'SHORTS_ACCESS_DENIED' })
      }
      if (error instanceof ShortsLlmFailedError) {
        return reply.status(502).send({ error: 'SHORTS_LLM_FAILED' })
      }
      throw error
    }
  }

  async scoreShorts(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    const body = req.body as ScoreShortsBody

    try {
      const result = await this.scoreShortsUseCase.execute({
        organizationId: req.organizationId,
        candidates: body.candidates,
        shortIdealJson: body.shortIdealJson,
        audioClips: body.audioClips,
      })
      return reply.status(200).send(result)
    } catch (error) {
      if (error instanceof EmptyCandidatesError) {
        return reply.status(400).send({ error: 'EMPTY_CANDIDATES' })
      }
      if (error instanceof TooManyClipsError) {
        return reply.status(400).send({ error: 'TOO_MANY_CLIPS' })
      }
      if (error instanceof InvalidAudioSegmentError) {
        return reply.status(400).send({ error: 'INVALID_AUDIO_SEGMENT' })
      }
      if (error instanceof FeatureAccessDeniedError) {
        return reply.status(403).send({ error: 'SHORTS_ACCESS_DENIED' })
      }
      throw error
    }
  }
}
