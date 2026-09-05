import type { AuthorizeFeatureUsageUseCase } from '../../../billing/application/use-cases/AuthorizeFeatureUsageUseCase'
import type { EmotionAnalyzerPort } from '../../domain/ports/EmotionAnalyzerPort'
import type { ShortsIntelligencePort } from '../../domain/ports/ShortsIntelligencePort'
import { ShortScorePromptBuilder, type CandidateForScoring } from '../services/ShortScorePromptBuilder'
import type { ShortIdealJson } from '../services/ShortPromptBuilder'
import type { UsageEventService } from '../services/UsageEventService'
import { DEEPSEEK_MODEL, SHORTS_AI_FEATURE } from '../../domain/constants'
import type { DetectedShortCandidate } from './DetectShortsUseCase'

const MAX_CLIPS = 30
const MAX_CLIP_SECONDS = 180
// Tolerancia para comparar start/end de punto flotante que cruzan la frontera HTTP
// (serialización JSON del cliente, o el LLM repitiendo el número en su respuesta) —
// una diferencia de sub-milisegundo no debe romper el match candidato<->clip/score.
const TIME_MATCH_EPSILON_SECONDS = 0.01

function findByTimeRange<T extends { start: number; end: number }>(
  items: T[],
  target: { start: number; end: number },
): T | undefined {
  return items.find(
    (item) =>
      Math.abs(item.start - target.start) < TIME_MATCH_EPSILON_SECONDS &&
      Math.abs(item.end - target.end) < TIME_MATCH_EPSILON_SECONDS,
  )
}

export class EmptyCandidatesError extends Error {
  constructor() {
    super('At least one short candidate is required')
    this.name = 'EmptyCandidatesError'
  }
}

export class TooManyClipsError extends Error {
  constructor(count: number) {
    super(`Too many audio clips: ${count} (max ${MAX_CLIPS})`)
    this.name = 'TooManyClipsError'
  }
}

export class InvalidAudioSegmentError extends Error {
  constructor(start: number, end: number) {
    super(`Invalid audio segment duration for clip [${start}, ${end}] (max ${MAX_CLIP_SECONDS}s)`)
    this.name = 'InvalidAudioSegmentError'
  }
}

export interface AudioClipForShort {
  start: number
  end: number
  audioBase64: string
}

export interface ScoreShortsInput {
  organizationId: string
  candidates: DetectedShortCandidate[]
  shortIdealJson?: ShortIdealJson
  audioClips: AudioClipForShort[]
}

export interface ScoredShort {
  start: number
  end: number
  confidence: number
  reason: string
  emotion: string | null
  score: number
}

export interface ScoreShortsOutput {
  shorts: ScoredShort[]
  warnings: string[]
}

/**
 * Paso 2 del flujo de creación de shorts: recibe los candidatos ya detectados
 * por DetectShortsUseCase (el frontend se los reenvía tal cual) más el audio
 * recortado de esos mismos tramos, analiza emoción con SenseVoice y pondera
 * el score final con una segunda pasada de DeepSeek.
 */
export class ScoreShortsUseCase {
  constructor(
    private readonly authorizeFeatureUsageUseCase: AuthorizeFeatureUsageUseCase,
    private readonly shortsIntelligencePort: ShortsIntelligencePort,
    private readonly emotionAnalyzerPort: EmotionAnalyzerPort,
    private readonly shortScorePromptBuilder: ShortScorePromptBuilder,
    private readonly usageEventService: UsageEventService,
  ) {}

  async execute(input: ScoreShortsInput): Promise<ScoreShortsOutput> {
    if (input.candidates.length === 0) {
      throw new EmptyCandidatesError()
    }
    if (input.audioClips.length > MAX_CLIPS) {
      throw new TooManyClipsError(input.audioClips.length)
    }
    for (const clip of input.audioClips) {
      if (clip.end - clip.start > MAX_CLIP_SECONDS || clip.end <= clip.start) {
        throw new InvalidAudioSegmentError(clip.start, clip.end)
      }
    }

    await this.authorizeFeatureUsageUseCase.requireEntitlement({
      organizationId: input.organizationId,
      feature: SHORTS_AI_FEATURE,
    })

    const warnings: string[] = []

    const emotionByCandidate = await this.analyzeEmotions(input.candidates, input.audioClips, warnings)

    const candidatesForScoring: CandidateForScoring[] = input.candidates.map((candidate, index) => ({
      start: candidate.start,
      end: candidate.end,
      confidence: candidate.confidence,
      reason: candidate.reason,
      emotion: emotionByCandidate[index] ?? undefined,
    }))

    const { scores, scoringUsage } = await this.scoreCandidates(candidatesForScoring, input.shortIdealJson, warnings)

    const shorts: ScoredShort[] = input.candidates
      .map((candidate, index) => ({
        start: candidate.start,
        end: candidate.end,
        confidence: candidate.confidence,
        reason: candidate.reason,
        emotion: emotionByCandidate[index] ?? null,
        score: scores[index] ?? candidate.confidence,
      }))
      .sort((a, b) => b.score - a.score)

    await this.usageEventService.record({
      organizationId: input.organizationId,
      feature: 'score_shorts',
      provider: 'deepseek',
      model: DEEPSEEK_MODEL,
      promptTokens: scoringUsage?.promptTokens ?? 0,
      completionTokens: scoringUsage?.completionTokens ?? 0,
      cost: null,
      metadata: { feature: 'score_shorts', nShorts: shorts.length, warnings },
    })

    return { shorts, warnings }
  }

  private async analyzeEmotions(
    candidates: DetectedShortCandidate[],
    audioClips: AudioClipForShort[],
    warnings: string[],
  ): Promise<(string | undefined)[]> {
    let anyFailed = false

    const results = await Promise.all(
      candidates.map(async (candidate) => {
        const clip = findByTimeRange(audioClips, candidate)
        if (!clip) {
          console.error(
            `[ScoreShortsUseCase] No audio clip found for candidate [${candidate.start}, ${candidate.end}] — treating as failed emotion analysis`,
          )
          anyFailed = true
          return undefined
        }
        try {
          const { emotion } = await this.emotionAnalyzerPort.analyze(clip.audioBase64)
          return emotion
        } catch {
          anyFailed = true
          return undefined
        }
      }),
    )

    if (anyFailed) {
      warnings.push('emotion_analysis_partial')
    }

    return results
  }

  private async scoreCandidates(
    candidates: CandidateForScoring[],
    shortIdealJson: ShortIdealJson | undefined,
    warnings: string[],
  ): Promise<{ scores: number[]; scoringUsage: { promptTokens: number; completionTokens: number } | null }> {
    const prompt = this.shortScorePromptBuilder.build({ candidates, shortIdeal: shortIdealJson })

    try {
      const result = await this.shortsIntelligencePort.scoreShorts(prompt)
      const scores = candidates.map((candidate) => {
        const scored = findByTimeRange(result.scored, candidate)
        if (!scored) {
          console.error(
            `[ScoreShortsUseCase] LLM did not return a score for candidate [${candidate.start}, ${candidate.end}] — falling back to confidence`,
          )
        }
        return scored?.score ?? candidate.confidence
      })
      return { scores, scoringUsage: result.usage }
    } catch {
      warnings.push('scoring_llm_failed_fallback_to_confidence')
      return { scores: candidates.map((c) => c.confidence), scoringUsage: null }
    }
  }
}
