import { eq } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { donations } from '../db/schema'
import { Donation } from '../../domain/entities/Donation'
import type { CreateDonationInput, DonationRepository } from '../../domain/ports/DonationRepository'

function toEntity(row: typeof donations.$inferSelect): Donation {
  return Donation.create({
    id: row.id,
    organizationId: row.organizationId,
    amountInCents: row.amountInCents,
    currency: row.currency,
    status: row.status,
    recurrenteCheckoutId: row.recurrenteCheckoutId,
  })
}

export class DrizzleDonationRepository implements DonationRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateDonationInput): Promise<Donation> {
    const [row] = await this.db
      .insert(donations)
      .values({
        organizationId: input.organizationId,
        amountInCents: input.amountInCents,
        currency: input.currency,
        status: 'pending',
        recurrenteCheckoutId: input.recurrenteCheckoutId,
      })
      .returning()

    if (!row) throw new Error('Failed to create donation')
    return toEntity(row)
  }

  async findByRecurrenteCheckoutId(recurrenteCheckoutId: string): Promise<Donation | null> {
    const [row] = await this.db
      .select()
      .from(donations)
      .where(eq(donations.recurrenteCheckoutId, recurrenteCheckoutId))
      .limit(1)
    return row ? toEntity(row) : null
  }

  async markSucceeded(id: string): Promise<void> {
    await this.db.update(donations).set({ status: 'succeeded', updatedAt: new Date() }).where(eq(donations.id, id))
  }
}
