export type OAuthProvider = 'google'

export interface OAuthAccountProps {
  id: string
  userId: string
  provider: OAuthProvider
  providerAccountId: string
  accessToken: string | null
  refreshToken: string | null
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export class OAuthAccount {
  private constructor(private readonly props: OAuthAccountProps) {}

  static create(props: OAuthAccountProps): OAuthAccount {
    return new OAuthAccount(props)
  }

  get id(): string {
    return this.props.id
  }

  get userId(): string {
    return this.props.userId
  }

  get provider(): OAuthProvider {
    return this.props.provider
  }

  get providerAccountId(): string {
    return this.props.providerAccountId
  }

  get accessToken(): string | null {
    return this.props.accessToken
  }

  get refreshToken(): string | null {
    return this.props.refreshToken
  }

  get expiresAt(): Date | null {
    return this.props.expiresAt
  }

  get createdAt(): Date {
    return this.props.createdAt
  }

  get updatedAt(): Date {
    return this.props.updatedAt
  }

  toJSON(): OAuthAccountProps {
    return this.props
  }
}
