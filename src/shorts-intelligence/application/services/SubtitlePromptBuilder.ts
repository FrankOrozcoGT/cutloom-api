import type { SubtitleSegmentInput } from '../../domain/ports/ShortsIntelligencePort'
import { renderPromptTemplate } from '../../infrastructure/prompts/loadPromptTemplate'

export interface BuildImproveSubtitlesPromptInput {
  segments: SubtitleSegmentInput[]
  userContext?: string
}

/**
 * Construye el prompt de corrección de subtítulos a partir del template
 * improve-subtitles.md (ver loadPromptTemplate) — preserva start/end en el
 * payload para que el LLM no tenga motivo (ni instrucción) para tocarlos —
 * solo debe corregir el campo `text`.
 */
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
