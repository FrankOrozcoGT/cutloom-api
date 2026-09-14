export type UsageEventMetadata =
  | { feature: 'improve_subtitles'; nCorrections: number }
  | { feature: 'detect_shorts'; nCandidates: number }
  | { feature: 'score_shorts'; nShorts: number; warnings: string[] }

export interface UsageEvent {
  organizationId: string
  feature: string
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  cost: number | null
  metadata: UsageEventMetadata
}

/** Filtrado siempre por organizationId (tenant) — ver DrizzleUsageEventRepository. */
export interface UsageEventRepository {
  record(event: UsageEvent): Promise<void>
  findByOrganization(organizationId: string): Promise<UsageEvent[]>
}
