import type { DonationRepository } from '../../domain/ports/DonationRepository'

export interface RecordDonationInput {
  organizationId: string | null
  amountInCents: number
  currency: string
  recurrenteCheckoutId: string
}

/** Registro idempotente por recurrenteCheckoutId, invocado desde el webhook payment.completed (tipo donation). */
export class RecordDonationUseCase {
  constructor(private readonly donationRepository: DonationRepository) {}

  async execute(input: RecordDonationInput): Promise<void> {
    const existing = await this.donationRepository.findByRecurrenteCheckoutId(input.recurrenteCheckoutId)
    if (existing) {
      return
    }

    const donation = await this.donationRepository.create({
      organizationId: input.organizationId,
      amountInCents: input.amountInCents,
      currency: input.currency,
      recurrenteCheckoutId: input.recurrenteCheckoutId,
    })

    await this.donationRepository.markSucceeded(donation.id)
  }
}
