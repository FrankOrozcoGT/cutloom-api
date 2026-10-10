import type { ContentRevision } from '../../domain/entities/ContentRevision'
import type { ContentRevisionRepository } from '../../domain/ports/ContentRevisionRepository'
import type { MetadataGenerator } from '../../domain/ports/MetadataGenerator'
import type { PublishingFeatureAuthorizer } from '../../domain/ports/PublishingFeatureAuthorizer'
import type { UsageEventRecorder } from '../../domain/ports/UsageEventRecorder'
import { YouTubeMetadataPromptBuilder, type VideoContext, type VideoContextSubtitle } from '../services/YouTubeMetadataPromptBuilder'
import type { Logger } from '../../../shared/domain/ports/Logger'
import { UsageEventAction } from '../../../shared/domain/entities/UsageEventAction'
import { Feature } from '../../../shared/domain/entities/Feature'

/** Minutos del video cubiertos por los subtítulos de contexto, redondeados hacia arriba — mismo
 * algoritmo que shorts-intelligence/domain/minutes.ts, copiado en vez de importado porque
 * publishing no depende de ese bounded context. */
function totalContextMinutes(subtitles: VideoContextSubtitle[]): number {
  const totalSeconds = subtitles.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0)
  return Math.max(1, Math.ceil(totalSeconds / 60))
}

export class MissingSubtitlesError extends Error {
  constructor() {
    super('"context.subtitles" is required — generating metadata without the actual video content is not supported')
    this.name = 'MissingSubtitlesError'
  }
}

export interface GenerateYouTubeMetadataInput {
  organizationId: string
  sourceId: string
  /** Tema/idea central del video — la keyword principal a optimizar. Opcional si context.summary ya lo cubre. */
  topic?: string
  tone?: string
  additionalInstructions?: string
  context: VideoContext & { subtitles: VideoContextSubtitle[] }
  /** Feedback del editor sobre la revisión anterior — si se omite, se genera desde cero (o desde la última revisión existente, si la hay). */
  feedback?: string
}

export class GenerateYouTubeMetadataUseCase {
  constructor(
    private readonly featureAuthorizer: PublishingFeatureAuthorizer,
    private readonly metadataGenerator: MetadataGenerator,
    private readonly promptBuilder: YouTubeMetadataPromptBuilder,
    private readonly contentRevisionRepository: ContentRevisionRepository,
    private readonly usageEventRecorder: UsageEventRecorder,
    private readonly logger: Logger,
  ) {}

  async execute(input: GenerateYouTubeMetadataInput): Promise<ContentRevision> {
    if (input.context.subtitles.length === 0) {
      throw new MissingSubtitlesError()
    }

    this.logger.info({ sourceId: input.sourceId }, '[GenerateYouTubeMetadata] requireEntitlement starting')
    await this.featureAuthorizer.requireEntitlement({
      organizationId: input.organizationId,
      feature: Feature.YouTubeAi,
      amount: totalContextMinutes(input.context.subtitles),
    })
    this.logger.info({ sourceId: input.sourceId }, '[GenerateYouTubeMetadata] requireEntitlement completed')

    this.logger.info({ sourceId: input.sourceId }, '[GenerateYouTubeMetadata] findLatestBySourceId starting')
    const latest = await this.contentRevisionRepository.findLatestBySourceId(input.organizationId, input.sourceId)
    this.logger.info({ sourceId: input.sourceId }, '[GenerateYouTubeMetadata] findLatestBySourceId completed')

    const prompt = this.promptBuilder.build({
      topic: input.topic,
      tone: input.tone,
      additionalInstructions: input.additionalInstructions,
      context: input.context,
      previousRevision: latest ? { metadata: latest.metadata, feedback: input.feedback } : undefined,
    })

    this.logger.info({ sourceId: input.sourceId }, '[GenerateYouTubeMetadata] metadataGenerator.generate starting')
    const { metadata, usage } = await this.metadataGenerator.generate(prompt)
    this.logger.info({ sourceId: input.sourceId }, '[GenerateYouTubeMetadata] metadataGenerator.generate completed')

    await this.usageEventRecorder.record({
      organizationId: input.organizationId,
      action: UsageEventAction.GenerateYouTubeMetadata,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    })

    this.logger.info({ sourceId: input.sourceId }, '[GenerateYouTubeMetadata] contentRevisionRepository.create starting')
    const revision = await this.contentRevisionRepository.create({
      organizationId: input.organizationId,
      sourceId: input.sourceId,
      prompt,
      metadata,
    })
    this.logger.info({ sourceId: input.sourceId }, '[GenerateYouTubeMetadata] contentRevisionRepository.create completed')
    return revision
  }
}
