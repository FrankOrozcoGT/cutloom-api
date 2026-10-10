import { UsageEventAction } from '../../../shared/domain/entities/UsageEventAction'

/** Puerto de publishing: el registro real de costo/uso vive en shorts-intelligence
 * (UsageEventService), inyectado como adaptador desde el composition root (ver server.ts) —
 * mismo patrón que PublishingFeatureAuthorizer. UsageEventAction vive en shared (no en
 * shorts-intelligence) exactamente para que publishing pueda tiparse contra el mismo enum
 * real sin depender de ese bounded context. */
interface RecordUsageEventInput {
  organizationId: string
  action: typeof UsageEventAction.GenerateYouTubeMetadata
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
}

export interface UsageEventRecorder {
  record(input: RecordUsageEventInput): Promise<void>
}
