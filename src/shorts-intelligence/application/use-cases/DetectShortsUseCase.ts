import type { AuthorizeFeatureUsageUseCase } from '../../../billing/application/use-cases/AuthorizeFeatureUsageUseCase'
import type { ShortsIntelligencePort, SubtitleSegmentInput } from '../../domain/ports/ShortsIntelligencePort'
import { ShortPromptBuilder, type ShortIdealJson } from '../services/ShortPromptBuilder'
import type { UsageEventService } from '../services/UsageEventService'
import { DEEPSEEK_MODEL, EmptySegmentsError, SHORTS_AI_FEATURE } from '../../domain/constants'

export class ShortsLlmFailedError extends Error {
  constructor(cause?: unknown) {
    super('Failed to detect shorts via LLM')
    this.name = 'ShortsLlmFailedError'
    this.cause = cause
  }
}

export interface DetectShortsInput {
  organizationId: string
  segments: SubtitleSegmentInput[]
  shortIdealJson?: ShortIdealJson
}

export interface DetectedShortCandidate {
  start: number
  end: number
  confidence: number
  reason: string
}

export interface DetectShortsOutput {
  candidates: DetectedShortCandidate[]
}

/**
 * Paso 1 del flujo de creación de shorts: solo texto (subtítulos), sin audio.
 * El frontend usa esta respuesta para saber qué tramos vale la pena recortar
 * en audio antes de llamar a ScoreShortsUseCase (evita mandar audio de tramos
 * que el LLM ni siquiera va a considerar).
 */
export class DetectShortsUseCase {
  constructor(
    private readonly authorizeFeatureUsageUseCase: AuthorizeFeatureUsageUseCase,
    private readonly shortsIntelligencePort: ShortsIntelligencePort,
    private readonly shortPromptBuilder: ShortPromptBuilder,
    private readonly usageEventService: UsageEventService,
  ) {}

  async execute(input: DetectShortsInput): Promise<DetectShortsOutput> {
    if (input.segments.length === 0) {
      throw new EmptySegmentsError()
    }

    await this.authorizeFeatureUsageUseCase.requireEntitlement({
      organizationId: input.organizationId,
      feature: SHORTS_AI_FEATURE,
    })

    const prompt = this.shortPromptBuilder.build({ segments: input.segments, shortIdeal: input.shortIdealJson })

    let result
    try {
      result = await this.shortsIntelligencePort.detectShorts(prompt)
    } catch (error) {
      throw new ShortsLlmFailedError(error)
    }

    await this.usageEventService.record({
      organizationId: input.organizationId,
      feature: 'detect_shorts',
      provider: 'deepseek',
      model: DEEPSEEK_MODEL,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      cost: null,
      metadata: { feature: 'detect_shorts', nCandidates: result.shorts.length },
    })

    return { candidates: result.shorts }
  }
}
