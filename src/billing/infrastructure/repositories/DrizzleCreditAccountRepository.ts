import { and, eq, gte, sql } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { creditAccounts, creditTransactions } from '../db/schema'
import { CreditAccount } from '../../domain/entities/CreditAccount'
import { InsufficientCreditsError } from '../../domain/ports/CreditAccountRepository'
import type { CreditAccountRepository } from '../../domain/ports/CreditAccountRepository'

function toEntity(row: typeof creditAccounts.$inferSelect): CreditAccount {
  return CreditAccount.create({ id: row.id, organizationId: row.organizationId, balance: row.balance })
}

export class DrizzleCreditAccountRepository implements CreditAccountRepository {
  constructor(private readonly db: Database) {}

  async findOrCreateByOrganizationId(organizationId: string): Promise<CreditAccount> {
    const [row] = await this.db
      .insert(creditAccounts)
      .values({ organizationId, balance: 0 })
      .onConflictDoNothing({ target: creditAccounts.organizationId })
      .returning()

    if (row) return toEntity(row)

    const [existing] = await this.db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.organizationId, organizationId))
      .limit(1)

    if (!existing) throw new Error(`Failed to find or create credit account for ${organizationId}`)
    return toEntity(existing)
  }

  async addCredits(organizationId: string, amount: number, recurrenteCheckoutId: string): Promise<CreditAccount> {
    return this.db.transaction(async (tx) => {
      const existingTx = await tx
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(eq(creditTransactions.recurrenteCheckoutId, recurrenteCheckoutId))
        .limit(1)

      if (existingTx[0]) {
        const [account] = await tx
          .select()
          .from(creditAccounts)
          .where(eq(creditAccounts.organizationId, organizationId))
          .limit(1)
        if (!account) throw new Error(`Credit account not found for ${organizationId}`)
        return toEntity(account)
      }

      await tx
        .insert(creditAccounts)
        .values({ organizationId, balance: 0 })
        .onConflictDoNothing({ target: creditAccounts.organizationId })

      const [account] = await tx
        .update(creditAccounts)
        .set({ balance: sql`${creditAccounts.balance} + ${amount}`, updatedAt: new Date() })
        .where(eq(creditAccounts.organizationId, organizationId))
        .returning()

      if (!account) throw new Error(`Failed to add credits for ${organizationId}`)

      await tx.insert(creditTransactions).values({
        organizationId,
        amount,
        reason: 'topup',
        recurrenteCheckoutId,
      })

      return toEntity(account)
    })
  }

  async deductCredits(organizationId: string, amount: number, reason: string): Promise<CreditAccount> {
    return this.db.transaction(async (tx) => {
      // El chequeo de saldo suficiente vive en el propio WHERE del UPDATE (atómico a nivel
      // de fila en Postgres) en vez de un SELECT previo — un SELECT-luego-UPDATE separado
      // deja una ventana de carrera donde dos requests concurrentes leen el mismo balance
      // antes de que ninguno haga commit, permitiendo que ambos pasen el chequeo y dejen
      // el balance negativo.
      const [updated] = await tx
        .update(creditAccounts)
        .set({ balance: sql`${creditAccounts.balance} - ${amount}`, updatedAt: new Date() })
        .where(and(eq(creditAccounts.organizationId, organizationId), gte(creditAccounts.balance, amount)))
        .returning()

      if (!updated) {
        const [account] = await tx
          .select()
          .from(creditAccounts)
          .where(eq(creditAccounts.organizationId, organizationId))
          .limit(1)
        if (!account) throw new Error(`Credit account not found for ${organizationId}`)
        throw new InsufficientCreditsError(organizationId)
      }

      await tx.insert(creditTransactions).values({
        organizationId,
        amount: -amount,
        reason,
        recurrenteCheckoutId: null,
      })

      return toEntity(updated)
    })
  }
}
