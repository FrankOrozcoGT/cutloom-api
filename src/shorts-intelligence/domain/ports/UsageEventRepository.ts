import type { Feature } from '../../../shared/domain/entities/Feature'
import { UsageEventAction } from '../../../shared/domain/entities/UsageEventAction'

interface UsageEventMetadataByAction {
  [UsageEventAction.ImproveSubtitles]: { action: typeof UsageEventAction.ImproveSubtitles; nCorrections: number }
  [UsageEventAction.DetectShorts]: { action: typeof UsageEventAction.DetectShorts; nCandidates: number }
  [UsageEventAction.ScoreShorts]: {
    action: typeof UsageEventAction.ScoreShorts
    nShorts: number
    warnings: string[]
  }
  [UsageEventAction.AnalyzeEmotion]: { action: typeof UsageEventAction.AnalyzeEmotion }
  [UsageEventAction.GenerateYouTubeMetadata]: { action: typeof UsageEventAction.GenerateYouTubeMetadata }
}

export type UsageEventMetadata = UsageEventMetadataByAction[UsageEventAction]

export interface UsageEvent {
  organizationId: string
  /** Acción granular que originó el evento — ver FEATURE_BY_USAGE_EVENT_ACTION para el paquete facturable al que pertenece. */
  action: UsageEventAction
  /** Paquete facturable (ver billing: features/plan_features/entitlements) — siempre derivado de `action` vía FEATURE_BY_USAGE_EVENT_ACTION, nunca decidido por el caller. */
  featureId: Feature
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
