import type { YouTubeMetadata } from '../../domain/entities/ContentRevision'
import { VideoPlatform } from '../../domain/entities/PublishedVideo'

// El short arranca 2 minutos antes del punto exacto de corte dentro del largo — así el
// espectador llega con contexto, no exactamente al frame donde empieza el short.
const LEAD_IN_SECONDS = 120

/**
 * Construye el link al video largo que se agrega a la descripción de cada short — con
 * timestamp de salto en YouTube (soporta ?t=Ns nativo); TikTok no tiene ningún parámetro de
 * URL para saltar a un segundo específico (confirmado contra su doc pública), así que ahí el
 * link queda sin offset, apunta al video completo.
 */
export function buildLongVideoLink(platform: VideoPlatform, longVideoUrl: string, longVideoTimestampSec: number): string {
  if (platform !== VideoPlatform.YouTube) return longVideoUrl

  const offsetSeconds = Math.max(0, Math.floor(longVideoTimestampSec) - LEAD_IN_SECONDS)
  const url = new URL(longVideoUrl)
  url.searchParams.set('t', `${offsetSeconds}s`)
  return url.toString()
}

/** Agrega el link al final de la descripción — nunca muta la ContentRevision original (que sigue siendo la metadata "pura" generada por IA); el link es un agregado de infraestructura solo al momento de publicar este short puntual. */
export function appendLongVideoLink(metadata: YouTubeMetadata, longVideoLink: string): YouTubeMetadata {
  return { ...metadata, description: `${metadata.description}\n\nMirá el video completo: ${longVideoLink}` }
}
