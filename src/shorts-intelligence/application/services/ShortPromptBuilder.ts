import type { SubtitleSegmentInput } from '../../domain/ports/ShortsIntelligencePort'
import type { PromptTemplateRenderer } from '../../../shared/domain/ports/PromptTemplateRenderer'

/**
 * Todos los campos son opcionales: si el usuario no los llenó en el form
 * simple, el prompt le pide a DeepSeek que los infiera del propio contenido
 * (subtítulos), sin depender de una llamada previa a improve-subtitles.
 */
export interface ShortIdealJson {
  topic?: string
  targetAudience?: string
  targetDurationSeconds?: number
  tone?: string
  count?: number
}

export interface BuildShortsPromptInput {
  segments: SubtitleSegmentInput[]
  shortIdeal?: ShortIdealJson
}

const DEFAULT_TARGET_DURATION_SECONDS = 45
const DEFAULT_COUNT = 8

/** Construye el prompt de detección de shorts a partir del template detect-shorts.md (ver loadPromptTemplate). */
export class ShortPromptBuilder {
  constructor(private readonly renderPromptTemplate: PromptTemplateRenderer) {}

  build(input: BuildShortsPromptInput): string {
    const ideal = input.shortIdeal ?? {}

    const topicLine = ideal.topic
      ? `Tema deseado: ${ideal.topic}`
      : 'Tema deseado: no especificado — elige los momentos más relevantes del contenido.'

    const audienceLine = ideal.targetAudience
      ? `Audiencia/mercado objetivo: ${ideal.targetAudience}`
      : 'Audiencia/mercado objetivo: no especificado — infiérelo del contenido de los subtítulos.'

    const toneLine = ideal.tone
      ? `Tono deseado: ${ideal.tone}`
      : 'Tono deseado: no especificado — detecta el tono real del contenido a partir de los subtítulos y respétalo.'

    const durationSeconds = ideal.targetDurationSeconds ?? DEFAULT_TARGET_DURATION_SECONDS
    const count = ideal.count ?? DEFAULT_COUNT

    return this.renderPromptTemplate('detect-shorts.md', {
      topicLine,
      audienceLine,
      toneLine,
      durationSeconds: String(durationSeconds),
      count: String(count),
      segments: JSON.stringify(input.segments),
    })
  }
}
