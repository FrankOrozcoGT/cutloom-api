import type { SubtitleSegmentInput } from '../../domain/ports/ShortsIntelligencePort'

export interface BuildImproveSubtitlesPromptInput {
  segments: SubtitleSegmentInput[]
  userContext?: string
}

/**
 * Construye el prompt de corrección de subtítulos. Preserva start/end en el
 * payload para que el LLM no tenga motivo (ni instrucción) para tocarlos —
 * solo debe corregir el campo `text`.
 */
export class SubtitlePromptBuilder {
  build(input: BuildImproveSubtitlesPromptInput): string {
    const contextBlock = input.userContext
      ? `Contexto del usuario (glosario de nicho, nombres propios, terminología especializada):\n${input.userContext}\n\n`
      : ''

    return `Eres un editor de subtítulos generados por transcripción automática (Whisper). Tu tarea es corregir el texto de cada subtítulo: corrige nombres propios o términos especializados mal transcritos usando el contexto si se provee, y mejora la fluidez de las oraciones sin cambiar el significado.

${contextBlock}Reglas estrictas:
- NO modifiques los valores "start" ni "end" de ningún subtítulo, devuélvelos exactamente iguales a los recibidos.
- Corrige solo el campo "text".
- Si un subtítulo ya está correcto, devuélvelo sin cambios.
- Genera también un "summary" breve (2-4 oraciones) de lo hablado en el video, útil como contexto para detectar shorts después.

Responde ÚNICAMENTE con un JSON con esta forma exacta:
{
  "summary": "string",
  "correctedSubtitles": [{ "start": number, "end": number, "text": "string" }]
}

Subtítulos originales:
${JSON.stringify(input.segments)}`
  }
}
