import type { FastifyReply, FastifyRequest } from 'fastify'
import { FeatureAccessDeniedError } from '../../domain/ports/FeatureUsageAuthorizer'
import { EmptySegmentsError } from '../../domain/constants'
import { SubtitlesLlmFailedError, type ImproveSubtitlesUseCase } from '../../application/use-cases/ImproveSubtitlesUseCase'
import {
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
import { isRecord } from '../../../shared/domain/validation'

export interface ImproveSubtitlesBody {
  segments: SubtitleSegmentInput[]
  userContext?: string
}

export interface DetectShortsBody {
  segments: SubtitleSegmentInput[]
  shortIdealJson?: ShortIdealJson
}

interface ScoreShortsPayload {
  candidates: DetectedShortCandidate[]
  shortIdealJson?: ShortIdealJson
}

export class InvalidScoreShortsPayloadError extends Error {
  constructor(reason: string) {
    super(`Invalid score shorts payload: ${reason}`)
    this.name = 'InvalidScoreShortsPayloadError'
  }
}

function isDetectedShortCandidate(value: unknown): value is DetectedShortCandidate {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.start === 'number' &&
    typeof value.end === 'number' &&
    typeof value.confidence === 'number' &&
    typeof value.reason === 'string'
  )
}

function isOptional<T>(value: unknown, check: (v: unknown) => v is T): value is T | undefined {
  return value === undefined || check(value)
}

function isShortIdealJson(value: unknown): value is ShortIdealJson {
  return (
    isRecord(value) &&
    isOptional(value.topic, (x): x is string => typeof x === 'string') &&
    isOptional(value.targetAudience, (x): x is string => typeof x === 'string') &&
    isOptional(value.targetDurationSeconds, (x): x is number => typeof x === 'number') &&
    isOptional(value.tone, (x): x is string => typeof x === 'string') &&
    isOptional(value.count, (x): x is number => typeof x === 'number')
  )
}

/** Único punto de validación del JSON crudo del campo "payload" del multipart — de aquí en adelante el tipo se propaga sin recastear. */
function parseScoreShortsPayload(raw: string): ScoreShortsPayload {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new InvalidScoreShortsPayloadError('"payload" is not valid JSON')
  }
  if (!isRecord(value)) {
    throw new InvalidScoreShortsPayloadError('"payload" must be a JSON object')
  }
  const candidates = value.candidates
  if (!Array.isArray(candidates) || !candidates.every(isDetectedShortCandidate)) {
    throw new InvalidScoreShortsPayloadError(
      '"payload.candidates" must be an array of {id,start,end,confidence,reason}',
    )
  }
  const shortIdealJson = value.shortIdealJson
  if (!isOptional(shortIdealJson, isShortIdealJson)) {
    throw new InvalidScoreShortsPayloadError(
      '"payload.shortIdealJson" must be an object with optional {topic,targetAudience,targetDurationSeconds,tone,count}',
    )
  }
  return { candidates, shortIdealJson }
}

/** Fieldname que el frontend usa para el archivo de audio de un candidato — ver contrato de POST /api/shorts/score. */
function audioFieldName(candidateId: string): string {
  return `audio_${candidateId}`
}

export class ShortsController {
  constructor(
    private readonly improveSubtitlesUseCase: ImproveSubtitlesUseCase,
    private readonly detectShortsUseCase: DetectShortsUseCase,
    private readonly scoreShortsUseCase: ScoreShortsUseCase,
  ) {}

  async improveSubtitles(req: FastifyRequest<{ Body: ImproveSubtitlesBody }>, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    try {
      const result = await this.improveSubtitlesUseCase.execute({
        organizationId: req.organizationId,
        segments: req.body.segments,
        userContext: req.body.userContext,
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

  async detectShorts(req: FastifyRequest<{ Body: DetectShortsBody }>, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    try {
      const result = await this.detectShortsUseCase.execute({
        organizationId: req.organizationId,
        segments: req.body.segments,
        shortIdealJson: req.body.shortIdealJson,
      })
      return reply.status(200).send(result)
    } catch (error) {
      if (error instanceof EmptySegmentsError) {
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

  /**
   * multipart/form-data: un campo de texto "payload" (JSON con candidates +
   * shortIdealJson) y un archivo de audio por candidato, nombrado
   * "audio_<candidate.id>" (ver audioFieldName).
   */
  async scoreShorts(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    try {
      let payload: ScoreShortsPayload | undefined
      const audioBuffersByField = new Map<string, Buffer>()

      for await (const part of req.parts()) {
        if (part.type === 'file') {
          audioBuffersByField.set(part.fieldname, await part.toBuffer())
        } else if (part.fieldname === 'payload') {
          payload = parseScoreShortsPayload(part.value as string)
        }
      }

      if (!payload) {
        throw new InvalidScoreShortsPayloadError('missing "payload" field')
      }

      const audioClips: AudioClipForShort[] = []
      for (const candidate of payload.candidates) {
        const buffer = audioBuffersByField.get(audioFieldName(candidate.id))
        if (buffer) {
          audioClips.push({ candidateId: candidate.id, audioBuffer: buffer })
        }
      }

      const result = await this.scoreShortsUseCase.execute({
        organizationId: req.organizationId,
        candidates: payload.candidates,
        shortIdealJson: payload.shortIdealJson,
        audioClips,
      })
      return reply.status(200).send(result)
    } catch (error) {
      if (error instanceof InvalidScoreShortsPayloadError) {
        return reply.status(400).send({ error: 'INVALID_PAYLOAD', message: error.message })
      }
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
