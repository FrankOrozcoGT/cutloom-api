import type { ShortIdealJson } from './ShortPromptBuilder'
import { renderPromptTemplate } from '../../infrastructure/prompts/loadPromptTemplate'

export interface CandidateForScoring {
  /** Posición del candidato en el array original — el LLM debe repetirlo tal cual en su respuesta en vez de reescribir start/end, así el match no depende de comparar floats. */
  index: number
  start: number
  end: number
  confidence: number
  reason: string
  /** Ausente si SenseVoice falló para este clip — el LLM debe scorear solo con confidence/reason. */
  emotion?: string
}

export interface BuildScorePromptInput {
  candidates: CandidateForScoring[]
  shortIdeal?: ShortIdealJson
}

/**
 * Segunda pasada, deliberadamente compacta: no repite subtítulos (ya se
 * gastaron en la primera pasada de detección) — solo manda los candidatos ya
 * resumidos + la intención del streamer (shortIdealJson), para que el LLM
 * pondere si la emoción detectada encaja con esa intención. Ver template
 * score-shorts.md (loadPromptTemplate).
 */
export class ShortScorePromptBuilder {
  build(input: BuildScorePromptInput): string {
    const ideal = input.shortIdeal ?? {}
    const intentLines = [
      ideal.topic ? `Tema: ${ideal.topic}` : null,
      ideal.targetAudience ? `Audiencia objetivo: ${ideal.targetAudience}` : null,
      ideal.tone ? `Tono deseado: ${ideal.tone}` : null,
    ].filter(Boolean)

    const intentBlock = intentLines.length > 0 ? intentLines.join('\n') + '\n\n' : ''

    return renderPromptTemplate('score-shorts.md', {
      intentBlock,
      candidates: JSON.stringify(input.candidates),
    })
  }
}
