import type { ContentRevision } from '../../domain/entities/ContentRevision'
import type { ContentRevisionRepository } from '../../domain/ports/ContentRevisionRepository'
import type { MetadataGenerator } from '../../domain/ports/MetadataGenerator'
import type { PublishingFeatureAuthorizer } from '../../domain/ports/PublishingFeatureAuthorizer'
import { YouTubeMetadataPromptBuilder, type VideoContext } from '../services/YouTubeMetadataPromptBuilder'
import type { Logger } from '../../../shared/domain/ports/Logger'

const YOUTUBE_AI_FEATURE = 'youtube_ai'

export class MissingTopicError extends Error {
  constructor() {
    super('"topic" is required when context.summary is not provided — nothing to infer the video theme from')
    this.name = 'MissingTopicError'
  }
}

export interface GenerateYouTubeMetadataInput {
  organizationId: string
  sourceId: string
  /** Tema/idea central del video — la keyword principal a optimizar. Opcional si context.summary ya lo cubre. */
  topic?: string
  tone?: string
  additionalInstructions?: string
  context?: VideoContext
  /** Feedback del editor sobre la revisión anterior — si se omite, se genera desde cero (o desde la última revisión existente, si la hay). */
  feedback?: string
}

export class GenerateYouTubeMetadataUseCase {
  constructor(
    private readonly featureAuthorizer: PublishingFeatureAuthorizer,
    private readonly metadataGenerator: MetadataGenerator,
    private readonly promptBuilder: YouTubeMetadataPromptBuilder,
    private readonly contentRevisionRepository: ContentRevisionRepository,
    private readonly logger: Logger,
  ) {}

  async execute(input: GenerateYouTubeMetadataInput): Promise<ContentRevision> {
    if (!input.topic && !input.context?.summary) {
      throw new MissingTopicError()
    }

    this.logger.info({ sourceId: input.sourceId }, '[GenerateYouTubeMetadata] requireEntitlement starting')
    await this.featureAuthorizer.requireEntitlement({
      organizationId: input.organizationId,
      feature: YOUTUBE_AI_FEATURE,
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
    const { metadata } = await this.metadataGenerator.generate(prompt)
    this.logger.info({ sourceId: input.sourceId }, '[GenerateYouTubeMetadata] metadataGenerator.generate completed')

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
