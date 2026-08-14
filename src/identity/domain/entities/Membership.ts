export type MembershipRole = 'owner' | 'member'

export interface MembershipProps {
  id: string
  userId: string
  organizationId: string
  role: MembershipRole
  createdAt: Date
}

export class Membership {
  private constructor(private readonly props: MembershipProps) {}

  static create(props: MembershipProps): Membership {
    return new Membership(props)
  }

  get id(): string {
    return this.props.id
  }

  get userId(): string {
    return this.props.userId
  }

  get organizationId(): string {
    return this.props.organizationId
  }

  get role(): MembershipRole {
    return this.props.role
  }

  get createdAt(): Date {
    return this.props.createdAt
  }

  toJSON(): MembershipProps {
    return this.props
  }
}
