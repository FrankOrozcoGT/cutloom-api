import type { SubtitleSegmentInput } from '../../domain/ports/ShortsIntelligencePort'
import type { PromptTemplateRenderer } from '../../../shared/domain/ports/PromptTemplateRenderer'

export interface BuildImproveSubtitlesPromptInput {
  segments: SubtitleSegmentInput[]
  userContext?: string
}

/** El payload incluye start/end de cada segmento sin pedirle al LLM que los toque, para que solo tenga oportunidad de modificar `text`. */
export class SubtitlePromptBuilder {
  constructor(private readonly renderPromptTemplate: PromptTemplateRenderer) {}

  build(input: BuildImproveSubtitlesPromptInput): string {
    const contextBlock = input.userContext
      ? `Contexto del usuario (glosario de nicho, nombres propios, terminología especializada):\n${input.userContext}\n\n`
      : ''

    return this.renderPromptTemplate('improve-subtitles.md', {
      contextBlock,
      segments: JSON.stringify(input.segments),
    })
  }
}
