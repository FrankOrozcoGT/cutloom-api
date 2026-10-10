/**
 * Catálogo de paquetes facturables — el nivel al que se le pone precio y tope de uso (ver
 * billing: plans/plan_features/entitlements). Vive en shared porque billing y
 * shorts-intelligence son ambos consumidores del mismo catálogo; ningún bounded context de
 * negocio depende de otro, igual que organizations.
 */
export const Feature = {
  ShortsAi: 'shorts_ai',
  AdvancedSubtitles: 'advanced_subtitles',
  YouTubeAi: 'youtube_ai',
} as const
export type Feature = (typeof Feature)[keyof typeof Feature]
