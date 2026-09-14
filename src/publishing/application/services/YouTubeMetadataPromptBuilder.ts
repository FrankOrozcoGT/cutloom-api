import type { YouTubeMetadata } from '../../domain/entities/ContentRevision'
import type { PromptTemplateRenderer } from '../../../shared/domain/ports/PromptTemplateRenderer'

export interface VideoContextSubtitle {
  start: number
  end: number
  text: string
}

export interface VideoContext {
  /** Resumen del contenido del video/segmento — dato opaco para publishing, provisto ya armado por el caller. */
  summary?: string
  /** Subtítulos del segmento, ya recortados al short en cuestión. */
  subtitles?: VideoContextSubtitle[]
  /** Motivo por el que se marcó este segmento como candidato — dato opaco para publishing. */
  detectedReason?: string
  /** Score de calidad del candidato, 0 a 1 — dato opaco para publishing. */
  score?: number
}

export interface BuildYouTubeMetadataPromptInput {
  /**
   * Tema/idea central del video — la keyword principal a optimizar (ver YouTube SEO: sin
   * esto no hay nada que optimizar). Opcional cuando context.summary ya lo cubre: el LLM
   * lo infiere del contexto en vez de pedírselo explícitamente al editor.
   */
  topic?: string
  /** Tono deseado (ej. "informal", "educativo serio") — opcional, afecta redacción pero no la idea central. */
  tone?: string
  /** Instrucciones sueltas del editor que no encajan en topic/tone (ej. restricciones puntuales, menciones a evitar). */
  additionalInstructions?: string
  context?: VideoContext
  previousRevision?: { metadata: YouTubeMetadata; feedback?: string }
}

function buildContextBlock(context: VideoContext | undefined): string {
  if (!context) return ''

  const lines: string[] = []
  if (context.summary) lines.push(`Resumen del video: ${context.summary}`)
  if (context.detectedReason) lines.push(`Motivo de detección como short: ${context.detectedReason}`)
  if (typeof context.score === 'number') lines.push(`Score de calidad del candidato: ${context.score}`)
  if (context.subtitles?.length) {
    const transcript = context.subtitles.map((s) => s.text).join(' ')
    lines.push(`Subtítulos del segmento: ${transcript}`)
  }

  if (lines.length === 0) return ''
  return `Contexto del video:\n${lines.join('\n')}\n\n`
}

function buildHistoryBlock(previousRevision: BuildYouTubeMetadataPromptInput['previousRevision']): string {
  if (!previousRevision) return ''

  const parts = [`Metadata generada previamente:\n${JSON.stringify(previousRevision.metadata)}`]
  if (previousRevision.feedback) {
    parts.push(`Feedback del editor para mejorarla: ${previousRevision.feedback}`)
  }
  return `${parts.join('\n')}\n\n`
}

function buildEditorPrompt(input: BuildYouTubeMetadataPromptInput): string {
  const lines = input.topic
    ? [`Tema del video: ${input.topic}`]
    : ['Tema del video: no especificado — infiere el tema/idea central a partir del contexto del video de abajo antes de generar la metadata.']
  if (input.tone) lines.push(`Tono deseado: ${input.tone}`)
  if (input.additionalInstructions) lines.push(`Instrucciones adicionales: ${input.additionalInstructions}`)
  return lines.join('\n')
}

/**
 * Recibe contexto de shorts-intelligence (summary, subtítulos, detectedReason, score) y el
 * historial de revisiones (para iterar con feedback) — el LLM en sí no conoce nada de esto,
 * solo recibe el prompt final ya armado como string.
 */
export class YouTubeMetadataPromptBuilder {
  constructor(private readonly renderPromptTemplate: PromptTemplateRenderer) {}

  build(input: BuildYouTubeMetadataPromptInput): string {
    return this.renderPromptTemplate('youtube-metadata.md', {
      contextBlock: buildContextBlock(input.context),
      historyBlock: buildHistoryBlock(input.previousRevision),
      prompt: buildEditorPrompt(input),
    })
  }
}
