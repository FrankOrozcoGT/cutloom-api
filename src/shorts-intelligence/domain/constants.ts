export const SHORTS_AI_FEATURE = 'shorts_ai'
/** Distinta de shorts_ai: mejora de subtítulos aplica a cualquier video, no solo al flujo de detección/scoring de shorts. */
export const ADVANCED_SUBTITLES_FEATURE = 'advanced_subtitles'
export const DEEPSEEK_MODEL = 'deepseek-v4-flash'

export class EmptySegmentsError extends Error {
  constructor() {
    super('At least one subtitle segment is required')
    this.name = 'EmptySegmentsError'
  }
}
