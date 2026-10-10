import { and, eq, gte, lt, sql } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import {
  creditAccount,
  creditLedgerEntries,
  creditLedgerExpirations,
  creditLedgerPlanGrants,
  creditLedgerTopups,
  creditLedgerUsages,
} from '../db/schema'
import { CreditAccount } from '../../domain/entities/CreditAccount'
import { InsufficientCreditsError } from '../../domain/ports/CreditAccountRepository'
import type { CreditAccountRepository } from '../../domain/ports/CreditAccountRepository'
import type { Feature } from '../../../shared/domain/entities/Feature'

function toEntity(row: typeof creditAccount.$inferSelect): CreditAccount {
  return CreditAccount.create({ id: row.id, organizationId: row.organizationId, balance: row.balance })
}

export class DrizzleCreditAccountRepository implements CreditAccountRepository {
  constructor(private readonly db: Database) {}

  async findOrCreateByOrganizationId(organizationId: string): Promise<CreditAccount> {
    const [row] = await this.db
      .insert(creditAccount)
      .values({ organizationId, balance: 0 })
      .onConflictDoNothing({ target: creditAccount.organizationId })
      .returning()

    if (row) return toEntity(row)

    const [existing] = await this.db.select().from(creditAccount).where(eq(creditAccount.organizationId, organizationId)).limit(1)

    if (!existing) throw new Error(`Failed to find or create credit account for ${organizationId}`)
    return toEntity(existing)
  }

  async grantFromPlan(organizationId: string, amount: number, subscriptionId: string, periodStart: Date): Promise<CreditAccount> {
    return this.db.transaction(async (tx) => {
      // Idempotente por (subscriptionId, periodStart): una recarga ya emitida para este ciclo
      // exacto no se repite — subscriptionId es fijo entre ciclos (no cambia en cada
      // renovación), así que periodStart es lo que distingue el ciclo real ante reintentos del
      // webhook de Recurrente.
      const existing = await tx
        .select({ ledgerEntryId: creditLedgerPlanGrants.ledgerEntryId })
        .from(creditLedgerPlanGrants)
        .where(and(eq(creditLedgerPlanGrants.subscriptionId, subscriptionId), eq(creditLedgerPlanGrants.periodStart, periodStart)))
        .limit(1)

      const [account] = await tx
        .select()
        .from(creditAccount)
        .where(eq(creditAccount.organizationId, organizationId))
        .limit(1)
      if (existing[0] && account) return toEntity(account)

      await tx.insert(creditAccount).values({ organizationId, balance: 0 }).onConflictDoNothing({ target: creditAccount.organizationId })

      const [updated] = await tx
        .update(creditAccount)
        .set({ balance: sql`${creditAccount.balance} + ${amount}`, updatedAt: new Date() })
        .where(eq(creditAccount.organizationId, organizationId))
        .returning()
      if (!updated) throw new Error(`Failed to grant plan credits for ${organizationId}`)

      const [entry] = await tx.insert(creditLedgerEntries).values({ organizationId, amount, type: 'plan_grant' }).returning({ id: creditLedgerEntries.id })
      if (!entry) throw new Error(`Failed to insert credit ledger entry for ${organizationId}`)
      await tx.insert(creditLedgerPlanGrants).values({ ledgerEntryId: entry.id, subscriptionId, periodStart })

      return toEntity(updated)
    })
  }

  async grantFromTopup(organizationId: string, amount: number, recurrenteCheckoutId: string): Promise<CreditAccount> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ ledgerEntryId: creditLedgerTopups.ledgerEntryId })
        .from(creditLedgerTopups)
        .where(eq(creditLedgerTopups.recurrenteCheckoutId, recurrenteCheckoutId))
        .limit(1)

      const [account] = await tx
        .select()
        .from(creditAccount)
        .where(eq(creditAccount.organizationId, organizationId))
        .limit(1)
      if (existing[0] && account) return toEntity(account)

      await tx.insert(creditAccount).values({ organizationId, balance: 0 }).onConflictDoNothing({ target: creditAccount.organizationId })

      const [updated] = await tx
        .update(creditAccount)
        .set({ balance: sql`${creditAccount.balance} + ${amount}`, updatedAt: new Date() })
        .where(eq(creditAccount.organizationId, organizationId))
        .returning()
      if (!updated) throw new Error(`Failed to grant topup credits for ${organizationId}`)

      const [entry] = await tx.insert(creditLedgerEntries).values({ organizationId, amount, type: 'topup' }).returning({ id: creditLedgerEntries.id })
      if (!entry) throw new Error(`Failed to insert credit ledger entry for ${organizationId}`)
      await tx.insert(creditLedgerTopups).values({ ledgerEntryId: entry.id, recurrenteCheckoutId })

      return toEntity(updated)
    })
  }

  async deductForUsage(organizationId: string, amount: number, feature: Feature): Promise<CreditAccount> {
    return this.db.transaction(async (tx) => {
      // El chequeo de saldo suficiente vive en el propio WHERE del UPDATE (atómico a nivel
      // de fila en Postgres) en vez de un SELECT previo — un SELECT-luego-UPDATE separado
      // deja una ventana de carrera donde dos requests concurrentes leen el mismo balance
      // antes de que ninguno haga commit, permitiendo que ambos pasen el chequeo y dejen
      // el balance negativo.
      const [updated] = await tx
        .update(creditAccount)
        .set({ balance: sql`${creditAccount.balance} - ${amount}`, updatedAt: new Date() })
        .where(and(eq(creditAccount.organizationId, organizationId), gte(creditAccount.balance, amount)))
        .returning()

      if (!updated) {
        const [account] = await tx
          .select()
          .from(creditAccount)
          .where(eq(creditAccount.organizationId, organizationId))
          .limit(1)
        if (!account) throw new Error(`Credit account not found for ${organizationId}`)
        throw new InsufficientCreditsError(organizationId)
      }

      const [entry] = await tx
        .insert(creditLedgerEntries)
        .values({ organizationId, amount: -amount, type: 'usage' })
        .returning({ id: creditLedgerEntries.id })
      if (!entry) throw new Error(`Failed to insert credit ledger entry for ${organizationId}`)
      await tx.insert(creditLedgerUsages).values({ ledgerEntryId: entry.id, feature })

      return toEntity(updated)
    })
  }

  async expireUnusedPlanGrants(organizationId: string, periodStart: Date): Promise<CreditAccount> {
    return this.db.transaction(async (tx) => {
      const alreadyExpired = await tx
        .select({ ledgerEntryId: creditLedgerExpirations.ledgerEntryId })
        .from(creditLedgerExpirations)
        .where(and(eq(creditLedgerExpirations.organizationId, organizationId), eq(creditLedgerExpirations.periodStart, periodStart)))
        .limit(1)

      const [account] = await tx.select().from(creditAccount).where(eq(creditAccount.organizationId, organizationId)).limit(1)
      if (!account) throw new Error(`Credit account not found for ${organizationId}`)
      if (alreadyExpired[0]) return toEntity(account)

      const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1))

      const [granted] = await tx
        .select({ total: sql<number>`coalesce(sum(${creditLedgerEntries.amount}), 0)` })
        .from(creditLedgerEntries)
        .innerJoin(creditLedgerPlanGrants, eq(creditLedgerPlanGrants.ledgerEntryId, creditLedgerEntries.id))
        .where(and(eq(creditLedgerEntries.organizationId, organizationId), eq(creditLedgerPlanGrants.periodStart, periodStart)))

      const [used] = await tx
        .select({ total: sql<number>`coalesce(sum(${creditLedgerEntries.amount}), 0)` })
        .from(creditLedgerEntries)
        .innerJoin(creditLedgerUsages, eq(creditLedgerUsages.ledgerEntryId, creditLedgerEntries.id))
        .where(
          and(
            eq(creditLedgerEntries.organizationId, organizationId),
            gte(creditLedgerEntries.createdAt, periodStart),
            lt(creditLedgerEntries.createdAt, periodEnd),
          ),
        )

      const grantedTotal = granted?.total ?? 0
      const usedTotal = Math.abs(used?.total ?? 0)
      const unused = grantedTotal - usedTotal

      if (unused <= 0) {
        const [entry] = await tx
          .insert(creditLedgerEntries)
          .values({ organizationId, amount: 0, type: 'expire' })
          .returning({ id: creditLedgerEntries.id })
        if (!entry) throw new Error(`Failed to insert credit ledger entry for ${organizationId}`)
        await tx.insert(creditLedgerExpirations).values({ ledgerEntryId: entry.id, organizationId, periodStart })
        return toEntity(account)
      }

      const [updated] = await tx
        .update(creditAccount)
        .set({ balance: sql`greatest(${creditAccount.balance} - ${unused}, 0)`, updatedAt: new Date() })
        .where(eq(creditAccount.organizationId, organizationId))
        .returning()
      if (!updated) throw new Error(`Failed to expire unused plan credits for ${organizationId}`)

      const [entry] = await tx
        .insert(creditLedgerEntries)
        .values({ organizationId, amount: -unused, type: 'expire' })
        .returning({ id: creditLedgerEntries.id })
      if (!entry) throw new Error(`Failed to insert credit ledger entry for ${organizationId}`)
      await tx.insert(creditLedgerExpirations).values({ ledgerEntryId: entry.id, organizationId, periodStart })

      return toEntity(updated)
    })
  }
}
