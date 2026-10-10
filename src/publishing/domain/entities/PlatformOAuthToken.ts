export interface PlatformOAuthTokenProps {
  id: string
  /** Cuenta de plataforma dueña de este token — ver PlatformAccount. Un token por cuenta, no por organización+plataforma: dos cuentas distintas de la misma organización tienen cada una su propio token. */
  platformAccountId: string
  encryptedAccessToken: string
  /** No todas las plataformas siempre devuelven refresh_token en cada reconexión — null si no vino esta vez. */
  encryptedRefreshToken: string | null
  expiresAt: Date
  /** Solo algunas plataformas (TikTok) emiten un refresh_token con vencimiento propio — null en las que no. */
  refreshExpiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export class PlatformOAuthToken {
  private constructor(private readonly props: PlatformOAuthTokenProps) {}

  static create(props: PlatformOAuthTokenProps): PlatformOAuthToken {
    return new PlatformOAuthToken(props)
  }

  get id(): string {
    return this.props.id
  }

  get platformAccountId(): string {
    return this.props.platformAccountId
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

  get refreshExpiresAt(): Date | null {
    return this.props.refreshExpiresAt
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
