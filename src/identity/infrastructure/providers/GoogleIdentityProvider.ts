import type { GoogleCredentials, IdentityProvider, NormalizedIdentity } from '../../domain/ports/IdentityProvider'

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo'
const SCOPES = ['openid', 'email', 'profile']

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleAuthError'
  }
}

interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  id_token: string
}

interface GoogleUserInfo {
  id: string
  email: string
  verified_email: boolean
  name?: string
}

export interface GoogleIdentityProviderOptions {
  clientId: string
  clientSecret: string
  /** Must exactly match an authorized redirect URI configured in Google Cloud Console. */
  redirectUri: string
}

/**
 * Server-side (confidential client) OAuth 2.0 flow: this backend owns the
 * redirect URI, holds the client secret, and exchanges the authorization
 * code for tokens directly with Google. The frontend never sees the client
 * id/secret or handles the code — it only triggers the redirect to
 * /api/auth/google/start and lands back on its own page once the backend
 * has established the session. No PKCE is needed here because a confidential
 * client (one that can keep a secret) already proves its identity to Google.
 */
export class GoogleIdentityProvider implements IdentityProvider {
  constructor(private readonly options: GoogleIdentityProviderOptions) {}

  buildAuthorizationUrl(state: string): string {
    const url = new URL(AUTHORIZATION_ENDPOINT)
    url.searchParams.set('client_id', this.options.clientId)
    url.searchParams.set('redirect_uri', this.options.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', SCOPES.join(' '))
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('state', state)
    return url.toString()
  }

  async validate(credentials: GoogleCredentials): Promise<NormalizedIdentity> {
    const tokens = await this.exchangeCodeForTokens(credentials.code)
    const profile = await this.fetchUserInfo(tokens.access_token)

    if (!profile.verified_email) {
      throw new GoogleAuthError('Google account email is not verified')
    }

    return {
      email: profile.email.toLowerCase(),
      name: profile.name ?? null,
      oauth: {
        provider: 'google',
        providerAccountId: profile.id,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      },
    }
  }

  private async exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse> {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        redirect_uri: this.options.redirectUri,
        grant_type: 'authorization_code',
      }),
    })

    if (!response.ok) {
      throw new GoogleAuthError('Failed to exchange authorization code with Google')
    }

    return (await response.json()) as GoogleTokenResponse
  }

  private async fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const response = await fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!response.ok) {
      throw new GoogleAuthError('Failed to fetch Google user info')
    }

    return (await response.json()) as GoogleUserInfo
  }
}
