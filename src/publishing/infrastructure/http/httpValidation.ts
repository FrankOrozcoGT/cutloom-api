import { VideoPlatform } from '../../domain/entities/PublishedVideo'

/** Error de validación de forma reutilizado por todos los parsers de publishing HTTP — no es exclusivo de un endpoint en particular. */
export class InvalidRequestError extends Error {
  constructor(reason: string) {
    super(`Invalid request: ${reason}`)
    this.name = 'InvalidRequestError'
  }
}

export function isVideoPlatform(value: unknown): value is VideoPlatform {
  return value === VideoPlatform.YouTube || value === VideoPlatform.TikTok
}
