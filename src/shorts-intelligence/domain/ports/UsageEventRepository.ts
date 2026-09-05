export interface UsageEvent {
  organizationId: string
  feature: string
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  cost: number | null
  metadata: Record<string, unknown>
}

/** Filtrado siempre por organizationId (tenant) — ver DrizzleUsageEventRepository. */
export interface UsageEventRepository {
  record(event: UsageEvent): Promise<void>
  findByOrganization(organizationId: string): Promise<UsageEvent[]>
}
