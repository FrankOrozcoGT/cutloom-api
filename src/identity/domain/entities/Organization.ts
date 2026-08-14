export interface OrganizationProps {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
}

export class Organization {
  private constructor(private readonly props: OrganizationProps) {}

  static create(props: OrganizationProps): Organization {
    return new Organization(props)
  }

  get id(): string {
    return this.props.id
  }

  get name(): string {
    return this.props.name
  }

  get createdAt(): Date {
    return this.props.createdAt
  }

  get updatedAt(): Date {
    return this.props.updatedAt
  }

  toJSON(): OrganizationProps {
    return this.props
  }
}
