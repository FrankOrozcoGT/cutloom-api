import type { Subscription, SubscriptionStatus } from '../entities/Subscription'

export interface UpsertSubscriptionInput {
  organizationId: string
  planId: string
  recurrenteSubscriptionId: string | null
  recurrenteCheckoutId: string | null
  status: SubscriptionStatus
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
}

export interface SubscriptionRepository {
  findByOrganizationId(organizationId: string): Promise<Subscription | null>
  findByRecurrenteSubscriptionId(recurrenteSubscriptionId: string): Promise<Subscription | null>
  findByRecurrenteCheckoutId(recurrenteCheckoutId: string): Promise<Subscription | null>
  upsertByOrganizationId(input: UpsertSubscriptionInput): Promise<Subscription>
  updateStatus(id: string, status: SubscriptionStatus): Promise<void>
  /** Caso bulk de updateStatus: actualiza el status de varias suscripciones en una sola operación. */
  updateStatusForIds(ids: string[], status: SubscriptionStatus): Promise<void>
  extendPeriod(id: string, currentPeriodStart: Date, currentPeriodEnd: Date): Promise<void>
  markPastDue(id: string, gracePeriodEndsAt: Date): Promise<void>
  setCancelAtPeriodEnd(id: string, cancelAtPeriodEnd: boolean): Promise<void>
  updatePlan(id: string, planId: string, currentPeriodStart: Date, currentPeriodEnd: Date): Promise<void>
  findExpiredPendingCancellation(now: Date): Promise<Subscription[]>
}
