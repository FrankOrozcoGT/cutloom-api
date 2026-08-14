export type AuthType = 'local' | 'google'

export interface UserProps {
  id: string
  email: string
  passwordHash: string | null
  authType: AuthType
  name: string | null
  createdAt: Date
  updatedAt: Date
}

export class User {
  private constructor(private readonly props: UserProps) {}

  static create(props: UserProps): User {
    if (props.authType === 'local' && !props.passwordHash) {
      throw new Error('Local users must have a passwordHash')
    }

    return new User(props)
  }

  get id(): string {
    return this.props.id
  }

  get email(): string {
    return this.props.email
  }

  get passwordHash(): string | null {
    return this.props.passwordHash
  }

  get authType(): AuthType {
    return this.props.authType
  }

  get name(): string | null {
    return this.props.name
  }

  get createdAt(): Date {
    return this.props.createdAt
  }

  get updatedAt(): Date {
    return this.props.updatedAt
  }

  toJSON(): Omit<UserProps, 'passwordHash'> {
    return {
      id: this.props.id,
      email: this.props.email,
      authType: this.props.authType,
      name: this.props.name,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    }
  }
}
