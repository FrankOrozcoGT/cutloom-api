export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password')
    this.name = 'InvalidCredentialsError'
  }
}

export class EmailExistsWithGoogleError extends Error {
  constructor() {
    super('This email is already registered via Google. Please sign in with Google.')
    this.name = 'EmailExistsWithGoogleError'
  }
}

export interface LocalCredentials {
  email: string
  password: string
}

export interface GoogleCredentials {
  code: string
}

export type IdentityCredentials = LocalCredentials | GoogleCredentials

export interface NormalizedIdentity {
  email: string
  name: string | null
  /** Present only when the provider validated an existing local user directly. */
  existingUserId?: string
  /** Present only for new local registrations, to persist on the new User. */
  passwordHash?: string
  /** Present only for OAuth providers, to link/create the OAuthAccount. */
  oauth?: {
    provider: 'google'
    providerAccountId: string
    accessToken: string | null
    refreshToken: string | null
    expiresAt: Date | null
  }
}

export interface IdentityProvider {
  validate(credentials: IdentityCredentials): Promise<NormalizedIdentity>
}
