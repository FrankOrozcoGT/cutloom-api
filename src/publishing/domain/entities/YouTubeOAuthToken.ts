export interface YouTubeOAuthTokenProps {
  id: string
  organizationId: string
  encryptedAccessToken: string
  /** Google no siempre devuelve refresh_token (solo en el primer consent con prompt=consent) — null si no vino. */
  encryptedRefreshToken: string | null
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

export class YouTubeOAuthToken {
  private constructor(private readonly props: YouTubeOAuthTokenProps) {}

  static create(props: YouTubeOAuthTokenProps): YouTubeOAuthToken {
    return new YouTubeOAuthToken(props)
  }

  get id(): string {
    return this.props.id
  }

  get organizationId(): string {
    return this.props.organizationId
  }

  get encryptedAccessToken(): string {
    return this.props.encryptedAccessToken
  }

  get encryptedRefreshToken(): string | null {
    return this.props.encryptedRefreshToken
  }

  get expiresAt(): Date {
    return this.props.expiresAt
  }

  get createdAt(): Date {
    return this.props.createdAt
  }

  get updatedAt(): Date {
    return this.props.updatedAt
  }

  isExpired(now: Date = new Date()): boolean {
    return now >= this.props.expiresAt
  }
}
