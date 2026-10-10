import type { YouTubeMetadata } from '../../domain/entities/ContentRevision'

export interface TikTokMetadata {
  title: string
}

// TikTok's Content Posting API documenta un máximo de 2200 caracteres UTF-16 para post_info.title.
const MAX_TITLE_LENGTH = 2200

/**
 * La metadata generada por IA es una sola por sourceId, compartida entre YouTube y TikTok
 * (mismo ContentRevision, mismo título/tags) — este adaptador no genera contenido nuevo, solo
 * traduce el shape de YouTubeMetadata al que exige la Content Posting API: TikTok no separa
 * título/descripción/tags como YouTube, así que se componen en un único texto con los tags
 * como hashtags al final, truncado al límite real de la plataforma.
 */
export function adaptMetadataForTikTok(metadata: YouTubeMetadata): TikTokMetadata {
  const hashtags = metadata.tags.map((tag) => `#${tag.replace(/\s+/g, '')}`).join(' ')
  const combined = hashtags ? `${metadata.title}\n\n${metadata.description}\n\n${hashtags}` : `${metadata.title}\n\n${metadata.description}`

  return { title: combined.slice(0, MAX_TITLE_LENGTH) }
}
