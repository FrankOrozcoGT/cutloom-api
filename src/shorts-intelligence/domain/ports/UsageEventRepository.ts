/** Discriminante de tipo — cada valor define su propio shape de metadata (ver UsageEventMetadataByFeature). */
export const UsageEventFeature = {
  ImproveSubtitles: 'improve_subtitles',
  DetectShorts: 'detect_shorts',
  ScoreShorts: 'score_shorts',
  AnalyzeEmotion: 'analyze_emotion',
  GenerateYouTubeMetadata: 'generate_youtube_metadata',
} as const
export type UsageEventFeature = (typeof UsageEventFeature)[keyof typeof UsageEventFeature]

interface UsageEventMetadataByFeature {
  [UsageEventFeature.ImproveSubtitles]: { feature: typeof UsageEventFeature.ImproveSubtitles; nCorrections: number }
  [UsageEventFeature.DetectShorts]: { feature: typeof UsageEventFeature.DetectShorts; nCandidates: number }
  [UsageEventFeature.ScoreShorts]: {
    feature: typeof UsageEventFeature.ScoreShorts
    nShorts: number
    warnings: string[]
  }
  [UsageEventFeature.AnalyzeEmotion]: { feature: typeof UsageEventFeature.AnalyzeEmotion }
  [UsageEventFeature.GenerateYouTubeMetadata]: { feature: typeof UsageEventFeature.GenerateYouTubeMetadata }
}

export type UsageEventMetadata = UsageEventMetadataByFeature[UsageEventFeature]

export interface UsageEvent {
  organizationId: string
  feature: string
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  cost: number | null
  metadata: UsageEventMetadata
  /** Cómputo local (ver SenseVoiceProcessManager) — null en eventos de LLM puro. */
  cpuTimeMicros?: number | null
  peakMemoryBytes?: number | null
}

/** Filtrado siempre por organizationId (tenant) — ver DrizzleUsageEventRepository. */
export interface UsageEventRepository {
  record(event: UsageEvent): Promise<void>
  findByOrganization(organizationId: string): Promise<UsageEvent[]>
}
