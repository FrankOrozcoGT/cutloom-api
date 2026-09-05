import type { AuthorizeFeatureUsageUseCase } from '../../../billing/application/use-cases/AuthorizeFeatureUsageUseCase'
import type { ShortsIntelligencePort, SubtitleSegmentInput } from '../../domain/ports/ShortsIntelligencePort'
import { SubtitleCorrection } from '../../domain/entities/SubtitleCorrection'
import { SubtitlePromptBuilder } from '../services/SubtitlePromptBuilder'
import type { UsageEventService } from '../services/UsageEventService'

export const SHORTS_AI_FEATURE = 'shorts_ai'
const DEEPSEEK_MODEL = 'deepseek-v4-flash'

export class EmptySegmentsError extends Error {
  constructor() {
    super('At least one subtitle segment is required')
    this.name = 'EmptySegmentsError'
  }
}

export class SubtitlesLlmFailedError extends Error {
  constructor(cause?: unknown) {
    super('Failed to improve subtitles via LLM')
    this.name = 'SubtitlesLlmFailedError'
    this.cause = cause
  }
}

export interface ImproveSubtitlesInput {
  organizationId: string
  segments: SubtitleSegmentInput[]
  userContext?: string
}

export interface ImproveSubtitlesOutput {
  summary: string
  correctedSubtitles: SubtitleCorrection[]
}

export class ImproveSubtitlesUseCase {
  constructor(
    private readonly authorizeFeatureUsageUseCase: AuthorizeFeatureUsageUseCase,
    private readonly shortsIntelligencePort: ShortsIntelligencePort,
    private readonly promptBuilder: SubtitlePromptBuilder,
    private readonly usageEventService: UsageEventService,
  ) {}

  async execute(input: ImproveSubtitlesInput): Promise<ImproveSubtitlesOutput> {
    if (input.segments.length === 0) {
      throw new EmptySegmentsError()
    }

    await this.authorizeFeatureUsageUseCase.requireEntitlement({
      organizationId: input.organizationId,
      feature: SHORTS_AI_FEATURE,
    })

    const prompt = this.promptBuilder.build({ segments: input.segments, userContext: input.userContext })

    let result
    try {
      result = await this.shortsIntelligencePort.improveSubtitles(prompt)
    } catch (error) {
      throw new SubtitlesLlmFailedError(error)
    }

    const correctedSubtitles = input.segments.map((original, index) => {
      const corrected = result.correctedSubtitles[index]
      return SubtitleCorrection.create({
        start: original.start,
        end: original.end,
        original: original.text,
        corrected: corrected?.text ?? original.text,
      })
    })

    await this.usageEventService.record({
      organizationId: input.organizationId,
      feature: 'improve_subtitles',
      provider: 'deepseek',
      model: DEEPSEEK_MODEL,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      cost: null,
      metadata: { nCorrections: correctedSubtitles.length },
    })

    return { summary: result.summary, correctedSubtitles }
  }
}
