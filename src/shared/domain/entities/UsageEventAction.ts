import { Feature } from './Feature'

/**
 * Acción granular que origina un evento de uso/costo — vive en shared (no en
 * shorts-intelligence) porque publishing también la necesita para registrar sus propios
 * eventos (ver GenerateYouTubeMetadataUseCase) sin depender de ese bounded context.
 */
export const UsageEventAction = {
  ImproveSubtitles: 'improve_subtitles',
  DetectShorts: 'detect_shorts',
  ScoreShorts: 'score_shorts',
  AnalyzeEmotion: 'analyze_emotion',
  GenerateYouTubeMetadata: 'generate_youtube_metadata',
} as const
export type UsageEventAction = (typeof UsageEventAction)[keyof typeof UsageEventAction]

/**
 * Jerarquía real: cada acción granular pertenece a exactamente un paquete facturable (Feature,
 * ver billing). Mapeo exhaustivo — TS obliga a cubrir todos los casos, así que una acción nueva
 * sin su paquete correspondiente no compila. Único punto de verdad: ningún caller decide el
 * featureId a mano (ver UsageEventService.record).
 */
export const FEATURE_BY_USAGE_EVENT_ACTION: Record<UsageEventAction, Feature> = {
  [UsageEventAction.ImproveSubtitles]: Feature.AdvancedSubtitles,
  [UsageEventAction.DetectShorts]: Feature.ShortsAi,
  [UsageEventAction.ScoreShorts]: Feature.ShortsAi,
  [UsageEventAction.AnalyzeEmotion]: Feature.ShortsAi,
  [UsageEventAction.GenerateYouTubeMetadata]: Feature.YouTubeAi,
}
