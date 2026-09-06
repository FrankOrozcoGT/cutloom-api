import type { SubtitleSegmentInput } from '../../domain/ports/ShortsIntelligencePort'
import { renderPromptTemplate } from '../../infrastructure/prompts/loadPromptTemplate'

export interface BuildImproveSubtitlesPromptInput {
  segments: SubtitleSegmentInput[]
  userContext?: string
}

/** El payload incluye start/end de cada segmento sin pedirle al LLM que los toque, para que solo tenga oportunidad de modificar `text`. */
export class SubtitlePromptBuilder {
  build(input: BuildImproveSubtitlesPromptInput): string {
    const contextBlock = input.userContext
      ? `Contexto del usuario (glosario de nicho, nombres propios, terminología especializada):\n${input.userContext}\n\n`
      : ''

    return renderPromptTemplate('improve-subtitles.md', {
      contextBlock,
      segments: JSON.stringify(input.segments),
    })
  }
}
