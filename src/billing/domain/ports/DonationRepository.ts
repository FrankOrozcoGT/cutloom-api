import type { Donation } from '../entities/Donation'

export interface CreateDonationInput {
  organizationId: string | null
  amountInCents: number
  currency: string
  recurrenteCheckoutId: string
}

export interface DonationRepository {
  create(input: CreateDonationInput): Promise<Donation>
  findByRecurrenteCheckoutId(recurrenteCheckoutId: string): Promise<Donation | null>
  markSucceeded(id: string): Promise<void>
}
