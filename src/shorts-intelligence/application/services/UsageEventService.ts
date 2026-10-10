import type { UsageEventMetadata, UsageEventRepository } from '../../domain/ports/UsageEventRepository'

export interface RecordUsageInput {
  organizationId: string
  feature: string
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  cost: number | null
  metadata: UsageEventMetadata
  /** Cómputo local (ver SenseVoiceProcessManager) — omitir en eventos de LLM puro. */
  cpuTimeMicros?: number | null
  peakMemoryBytes?: number | null
}

/**
 * Registro de uso/costo best-effort: una falla al persistir NO debe romper la
 * respuesta del feature que la invoca (ver ImproveSubtitlesUseCase/CreateShortsUseCase).
 */
export class UsageEventService {
  constructor(private readonly usageEventRepository: UsageEventRepository) {}

  async record(input: RecordUsageInput): Promise<void> {
    try {
      await this.usageEventRepository.record({
        organizationId: input.organizationId,
        feature: input.feature,
        provider: input.provider,
        model: input.model,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        cost: input.cost,
        metadata: input.metadata,
        cpuTimeMicros: input.cpuTimeMicros ?? null,
        peakMemoryBytes: input.peakMemoryBytes ?? null,
      })
    } catch (error) {
      console.error('Failed to record usage event', { feature: input.feature, error })
    }
  }
}
