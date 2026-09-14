import type { FeatureUsageAuthorizer } from '../../domain/ports/FeatureUsageAuthorizer'
import type { ShortsIntelligencePort, SubtitleSegmentInput } from '../../domain/ports/ShortsIntelligencePort'
import { SubtitleCorrection } from '../../domain/entities/SubtitleCorrection'
import { SubtitlePromptBuilder } from '../services/SubtitlePromptBuilder'
import type { UsageEventService } from '../services/UsageEventService'
import { ADVANCED_SUBTITLES_FEATURE, DEEPSEEK_MODEL, EmptySegmentsError } from '../../domain/constants'
import { totalMinutes } from '../../domain/minutes'

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
    private readonly featureUsageAuthorizer: FeatureUsageAuthorizer,
    private readonly shortsIntelligencePort: ShortsIntelligencePort,
    private readonly promptBuilder: SubtitlePromptBuilder,
    private readonly usageEventService: UsageEventService,
  ) {}

  async execute(input: ImproveSubtitlesInput): Promise<ImproveSubtitlesOutput> {
    if (input.segments.length === 0) {
      throw new EmptySegmentsError()
    }

    await this.featureUsageAuthorizer.requireEntitlement({
      organizationId: input.organizationId,
      feature: ADVANCED_SUBTITLES_FEATURE,
      amount: totalMinutes(input.segments),
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
      metadata: { feature: 'improve_subtitles', nCorrections: correctedSubtitles.length },
    })

    return { summary: result.summary, correctedSubtitles }
  }
}
