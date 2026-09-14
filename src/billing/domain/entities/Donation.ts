export type DonationStatus = 'pending' | 'succeeded' | 'failed'

export interface DonationProps {
  id: string
  organizationId: string | null
  amountInCents: number
  currency: string
  status: DonationStatus
  recurrenteCheckoutId: string
}

export class Donation {
  private constructor(private readonly props: DonationProps) {}

  static create(props: DonationProps): Donation {
    return new Donation(props)
  }

  get id(): string {
    return this.props.id
  }

  get organizationId(): string | null {
    return this.props.organizationId
  }

  get amountInCents(): number {
    return this.props.amountInCents
  }

  get currency(): string {
    return this.props.currency
  }

  get status(): DonationStatus {
    return this.props.status
  }

  get recurrenteCheckoutId(): string {
    return this.props.recurrenteCheckoutId
  }
}
