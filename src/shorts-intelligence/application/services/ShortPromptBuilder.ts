import type { SubtitleSegmentInput } from '../../domain/ports/ShortsIntelligencePort'

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

export class ShortPromptBuilder {
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

    return `Eres un editor experto en identificar los mejores momentos de un video largo (podcast, entrevista, tutorial) para convertirlos en shorts/clips verticales de alto rendimiento en YouTube Shorts y TikTok.

Criterios de selección usados por editores y herramientas profesionales del mercado:
- Gancho fuerte en los primeros segundos del clip (una afirmación llamativa, una pregunta, un dato sorprendente).
- Ritmo: sin relleno, sin rodeos, va directo a la idea.
- Valor/idea autocontenida: el clip debe entenderse sin contexto externo.
- Arco emocional claro dentro del tramo.

${topicLine}
${audienceLine}
${toneLine}
Duración objetivo por short: ~${durationSeconds} segundos.
Cantidad de candidatos a generar: ${count}.

Reglas estrictas:
- Usa únicamente los tiempos (start/end) de los subtítulos recibidos, no inventes tiempos fuera de ese rango.
- Cada short debe tener un "confidence" entre 0 y 1 (qué tan seguro estás de que es un buen candidato) y un "reason" breve explicando por qué.

Responde ÚNICAMENTE con un JSON con esta forma exacta:
{
  "shorts": [{ "start": number, "end": number, "confidence": number, "reason": "string" }]
}

Subtítulos del video:
${JSON.stringify(input.segments)}`
  }
}
