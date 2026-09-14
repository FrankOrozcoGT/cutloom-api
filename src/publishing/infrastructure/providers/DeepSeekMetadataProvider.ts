import type { GenerateMetadataResult, MetadataGenerator } from '../../domain/ports/MetadataGenerator'
import { InvalidYouTubeMetadataError, parseYouTubeMetadata } from '../../domain/entities/ContentRevision'
import type { Logger } from '../../../shared/domain/ports/Logger'
import {
  DeepSeekChatClient,
  DeepSeekMalformedResponseError,
  type DeepSeekConfig,
} from '../../../shared/infrastructure/providers/DeepSeekChatClient'

export type { DeepSeekConfig }

export class DeepSeekMetadataProvider implements MetadataGenerator {
  private readonly client: DeepSeekChatClient

  constructor(config: DeepSeekConfig, logger: Logger) {
    this.client = new DeepSeekChatClient(config, logger)
  }

  async generate(prompt: string): Promise<GenerateMetadataResult> {
    const { parsed, usage } = await this.client.call(prompt)
    try {
      // parseYouTubeMetadata es el validador único de dominio (ver ContentRevision.ts),
      // compartido con DrizzleContentRevisionRepository — no se reintenta acá: shape
      // inválido es determinista para este contenido, ya se agotaron los retries de red.
      return { metadata: parseYouTubeMetadata(parsed), usage }
    } catch (error) {
      if (error instanceof InvalidYouTubeMetadataError) {
        throw new DeepSeekMalformedResponseError('DeepSeek response does not match the expected YouTube metadata shape')
      }
      throw error
    }
  }
}
