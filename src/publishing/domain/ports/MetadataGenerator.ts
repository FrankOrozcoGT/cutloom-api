import type { YouTubeMetadata } from '../entities/ContentRevision'

export interface GenerateMetadataResult {
  metadata: YouTubeMetadata
  usage: { promptTokens: number; completionTokens: number }
}

export interface MetadataGenerator {
  generate(prompt: string): Promise<GenerateMetadataResult>
}
