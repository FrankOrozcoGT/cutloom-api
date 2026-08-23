export interface CreditAccountProps {
  id: string
  organizationId: string
  balance: number
}

export class CreditAccount {
  private constructor(private readonly props: CreditAccountProps) {}

  static create(props: CreditAccountProps): CreditAccount {
    return new CreditAccount(props)
  }

  get id(): string {
    return this.props.id
  }

  get organizationId(): string {
    return this.props.organizationId
  }

  get balance(): number {
    return this.props.balance
  }
}
