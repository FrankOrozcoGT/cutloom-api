export const SHORTS_AI_FEATURE = 'shorts_ai'
export const DEEPSEEK_MODEL = 'deepseek-v4-flash'

export class EmptySegmentsError extends Error {
  constructor() {
    super('At least one subtitle segment is required')
    this.name = 'EmptySegmentsError'
  }
}
