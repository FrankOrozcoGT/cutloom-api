export type SubscriptionStatus = 'active' | 'past_due' | 'inactive'

export interface SubscriptionProps {
  id: string
  organizationId: string
  planId: string
  recurrenteSubscriptionId: string | null
  recurrenteCheckoutId: string | null
  status: SubscriptionStatus
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  gracePeriodEndsAt: Date | null
}

export class Subscription {
  private constructor(private readonly props: SubscriptionProps) {}

  static create(props: SubscriptionProps): Subscription {
    return new Subscription(props)
  }

  get id(): string {
    return this.props.id
  }

  get organizationId(): string {
    return this.props.organizationId
  }

  get planId(): string {
    return this.props.planId
  }

  get recurrenteSubscriptionId(): string | null {
    return this.props.recurrenteSubscriptionId
  }

  get recurrenteCheckoutId(): string | null {
    return this.props.recurrenteCheckoutId
  }

  get status(): SubscriptionStatus {
    return this.props.status
  }

  get currentPeriodStart(): Date | null {
    return this.props.currentPeriodStart
  }

  get currentPeriodEnd(): Date | null {
    return this.props.currentPeriodEnd
  }

  get cancelAtPeriodEnd(): boolean {
    return this.props.cancelAtPeriodEnd
  }

  get gracePeriodEndsAt(): Date | null {
    return this.props.gracePeriodEndsAt
  }

  isPeriodExpired(now: Date = new Date()): boolean {
    return this.props.currentPeriodEnd !== null && now >= this.props.currentPeriodEnd
  }
}
