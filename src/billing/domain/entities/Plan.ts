export type SubscriptionInterval = 'month' | 'year'

export interface PlanProps {
  id: string
  name: string
  recurrentePriceId: string
  amountInCents: number
  currency: string
  interval: SubscriptionInterval
  /** Créditos acreditados a creditAccount.balance cada vez que se paga este plan — un único pozo total, no por feature. */
  creditsPerCycle: number
}

export class Plan {
  private constructor(private readonly props: PlanProps) {}

  static create(props: PlanProps): Plan {
    return new Plan(props)
  }

  get id(): string {
    return this.props.id
  }

  get name(): string {
    return this.props.name
  }

  get recurrentePriceId(): string {
    return this.props.recurrentePriceId
  }

  get amountInCents(): number {
    return this.props.amountInCents
  }

  get currency(): string {
    return this.props.currency
  }

  get interval(): SubscriptionInterval {
    return this.props.interval
  }

  get creditsPerCycle(): number {
    return this.props.creditsPerCycle
  }
}
