import type {
  DetectShortsResult,
  ImproveSubtitlesResult,
  ScoreShortsResult,
  ShortsIntelligencePort,
} from '../../domain/ports/ShortsIntelligencePort'
import { isRecord } from '../../../shared/domain/validation'
import type { Logger } from '../../../shared/domain/ports/Logger'
import { DeepSeekChatClient, type DeepSeekConfig } from '../../../shared/infrastructure/providers/DeepSeekChatClient'

export type { DeepSeekConfig }

interface ImproveSubtitlesShape {
  summary: string
  correctedSubtitles: { start: number; end: number; text: string }[]
}

interface DetectShortsShape {
  shorts: { start: number; end: number; confidence: number; reason: string }[]
}

interface ScoreShortsShape {
  scored: { index: number; score: number }[]
}

function isSubtitleSegment(value: unknown): value is { start: number; end: number; text: string } {
  return isRecord(value) && typeof value.start === 'number' && typeof value.end === 'number' && typeof value.text === 'string'
}

function isShortCandidate(value: unknown): value is { start: number; end: number; confidence: number; reason: string } {
  return (
    isRecord(value) &&
    typeof value.start === 'number' &&
    typeof value.end === 'number' &&
    typeof value.confidence === 'number' &&
    typeof value.reason === 'string'
  )
}

function isScoredShort(value: unknown): value is { index: number; score: number } {
  return isRecord(value) && typeof value.index === 'number' && typeof value.score === 'number'
}

/** Único punto de validación de forma para respuestas del LLM — de aquí en adelante el tipo se propaga sin recastear. */
function parseImproveSubtitlesShape(value: unknown): ImproveSubtitlesShape {
  if (!isRecord(value) || typeof value.summary !== 'string' || !Array.isArray(value.correctedSubtitles)) {
    throw new Error('DeepSeek response does not match the expected improveSubtitles shape')
  }
  const correctedSubtitles = value.correctedSubtitles
  if (!correctedSubtitles.every(isSubtitleSegment)) {
    throw new Error('DeepSeek response does not match the expected improveSubtitles shape')
  }
  return { summary: value.summary, correctedSubtitles }
}

function parseDetectShortsShape(value: unknown): DetectShortsShape {
  if (!isRecord(value) || !Array.isArray(value.shorts) || !value.shorts.every(isShortCandidate)) {
    throw new Error('DeepSeek response does not match the expected detectShorts shape')
  }
  return { shorts: value.shorts }
}

function parseScoreShortsShape(value: unknown): ScoreShortsShape {
  if (!isRecord(value) || !Array.isArray(value.scored) || !value.scored.every(isScoredShort)) {
    throw new Error('DeepSeek response does not match the expected scoreShorts shape')
  }
  return { scored: value.scored }
}

export class DeepSeekProvider implements ShortsIntelligencePort {
  private readonly client: DeepSeekChatClient

  constructor(config: DeepSeekConfig, logger: Logger) {
    this.client = new DeepSeekChatClient(config, logger)
  }

  async improveSubtitles(prompt: string): Promise<ImproveSubtitlesResult> {
    const { parsed, usage } = await this.client.call(prompt)
    const result = parseImproveSubtitlesShape(parsed)
    return { summary: result.summary, correctedSubtitles: result.correctedSubtitles, usage }
  }

  async detectShorts(prompt: string): Promise<DetectShortsResult> {
    const { parsed, usage } = await this.client.call(prompt)
    const result = parseDetectShortsShape(parsed)
    return { shorts: result.shorts, usage }
  }

  async scoreShorts(prompt: string): Promise<ScoreShortsResult> {
    const { parsed, usage } = await this.client.call(prompt)
    const result = parseScoreShortsShape(parsed)
    return { scored: result.scored, usage }
  }
}
