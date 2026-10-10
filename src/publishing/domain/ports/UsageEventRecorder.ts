/** Puerto de publishing: el registro real de costo/uso vive en shorts-intelligence
 * (UsageEventService), inyectado como adaptador desde el composition root (ver server.ts) —
 * mismo patrón que PublishingFeatureAuthorizer. */
interface RecordUsageEventInput {
  organizationId: string
  feature: string
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
}

export interface UsageEventRecorder {
  record(input: RecordUsageEventInput): Promise<void>
}
