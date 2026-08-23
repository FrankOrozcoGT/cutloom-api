import { and, eq, lt } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { subscriptions } from '../db/schema'
import { Subscription } from '../../domain/entities/Subscription'
import type {
  SubscriptionRepository,
  UpsertSubscriptionInput,
} from '../../domain/ports/SubscriptionRepository'

function toEntity(row: typeof subscriptions.$inferSelect): Subscription {
  return Subscription.create({
    id: row.id,
    organizationId: row.organizationId,
    planId: row.planId,
    recurrenteSubscriptionId: row.recurrenteSubscriptionId,
    recurrenteCheckoutId: row.recurrenteCheckoutId,
    status: row.status,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    gracePeriodEndsAt: row.gracePeriodEndsAt,
  })
}

export class DrizzleSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly db: Database) {}

  async findByOrganizationId(organizationId: string): Promise<Subscription | null> {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId))
      .limit(1)
    return row ? toEntity(row) : null
  }

  async findByRecurrenteSubscriptionId(recurrenteSubscriptionId: string): Promise<Subscription | null> {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.recurrenteSubscriptionId, recurrenteSubscriptionId))
      .limit(1)
    return row ? toEntity(row) : null
  }

  async findByRecurrenteCheckoutId(recurrenteCheckoutId: string): Promise<Subscription | null> {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.recurrenteCheckoutId, recurrenteCheckoutId))
      .limit(1)
    return row ? toEntity(row) : null
  }

  async upsertByOrganizationId(input: UpsertSubscriptionInput): Promise<Subscription> {
    const [row] = await this.db
      .insert(subscriptions)
      .values({
        organizationId: input.organizationId,
        planId: input.planId,
        recurrenteSubscriptionId: input.recurrenteSubscriptionId,
        recurrenteCheckoutId: input.recurrenteCheckoutId,
        status: input.status,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
      })
      .onConflictDoUpdate({
        target: subscriptions.organizationId,
        set: {
          planId: input.planId,
          recurrenteSubscriptionId: input.recurrenteSubscriptionId,
          recurrenteCheckoutId: input.recurrenteCheckoutId,
          status: input.status,
          currentPeriodStart: input.currentPeriodStart,
          currentPeriodEnd: input.currentPeriodEnd,
          cancelAtPeriodEnd: false,
          gracePeriodEndsAt: null,
          updatedAt: new Date(),
        },
      })
      .returning()

    if (!row) throw new Error('Failed to upsert subscription')
    return toEntity(row)
  }

  async updateStatus(id: string, status: Subscription['status']): Promise<void> {
    await this.db.update(subscriptions).set({ status, updatedAt: new Date() }).where(eq(subscriptions.id, id))
  }

  async extendPeriod(id: string, currentPeriodStart: Date, currentPeriodEnd: Date): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({
        currentPeriodStart,
        currentPeriodEnd,
        status: 'active',
        gracePeriodEndsAt: null,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, id))
  }

  async markPastDue(id: string, gracePeriodEndsAt: Date): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({ status: 'past_due', gracePeriodEndsAt, updatedAt: new Date() })
      .where(eq(subscriptions.id, id))
  }

  async clearPastDue(id: string): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({ gracePeriodEndsAt: null, updatedAt: new Date() })
      .where(eq(subscriptions.id, id))
  }

  async setCancelAtPeriodEnd(id: string, cancelAtPeriodEnd: boolean): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd, updatedAt: new Date() })
      .where(eq(subscriptions.id, id))
  }

  async updatePlan(id: string, planId: string, currentPeriodStart: Date, currentPeriodEnd: Date): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({ planId, currentPeriodStart, currentPeriodEnd, status: 'active', updatedAt: new Date() })
      .where(eq(subscriptions.id, id))
  }

  async findExpiredPendingCancellation(now: Date): Promise<Subscription[]> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.cancelAtPeriodEnd, true), lt(subscriptions.currentPeriodEnd, now)))
    return rows.map(toEntity)
  }
}
