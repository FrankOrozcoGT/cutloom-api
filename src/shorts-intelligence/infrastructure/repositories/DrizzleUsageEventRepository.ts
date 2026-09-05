import { eq } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { usageEvents } from '../db/schema'
import type { UsageEvent, UsageEventRepository } from '../../domain/ports/UsageEventRepository'

function toEvent(row: typeof usageEvents.$inferSelect): UsageEvent {
  return {
    organizationId: row.organizationId,
    feature: row.feature,
    provider: row.provider,
    model: row.model,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    cost: row.cost,
    metadata: row.metadata as Record<string, unknown>,
  }
}

export class DrizzleUsageEventRepository implements UsageEventRepository {
  constructor(private readonly db: Database) {}

  async record(event: UsageEvent): Promise<void> {
    await this.db.insert(usageEvents).values({
      organizationId: event.organizationId,
      feature: event.feature,
      provider: event.provider,
      model: event.model,
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
      cost: event.cost,
      metadata: event.metadata,
    })
  }

  async findByOrganization(organizationId: string): Promise<UsageEvent[]> {
    const rows = await this.db.select().from(usageEvents).where(eq(usageEvents.organizationId, organizationId))
    return rows.map(toEvent)
  }
}
