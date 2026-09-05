import type { ShortIdealJson } from './ShortPromptBuilder'

export interface CandidateForScoring {
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
 * pondere si la emoción detectada encaja con esa intención.
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

    return `Eres un editor experto evaluando candidatos a short ya detectados en un video. Para cada candidato tienes su "confidence" (qué tan buen momento es, según el análisis de contenido) y, cuando fue posible analizarla, la "emotion" detectada en el audio del clip (categoría cruda: HAPPY, SAD, ANGRY, NEUTRAL, etc).

${intentBlock}Tu tarea: asignar un "score" final (0 a 1) a cada candidato, combinando su confidence con qué tan bien encaja la emoción detectada con la intención del streamer (tema/audiencia/tono arriba). Si un candidato no tiene "emotion" (el análisis de audio falló para ese clip), evalúa solo con confidence y reason.

Reglas estrictas:
- No inventes candidatos nuevos, ni cambies start/end.
- Responde en el mismo orden en que recibiste los candidatos.

Responde ÚNICAMENTE con un JSON con esta forma exacta:
{
  "scored": [{ "start": number, "end": number, "score": number }]
}

Candidatos:
${JSON.stringify(input.candidates)}`
  }
}
