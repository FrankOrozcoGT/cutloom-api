import type { GoogleCredentials, IdentityProvider, NormalizedIdentity } from '../../domain/ports/IdentityProvider'
import {
  exchangeCodeForGoogleTokens,
  GoogleTokenEndpointError,
  type GoogleTokens,
} from '../../../shared/infrastructure/providers/GoogleTokenEndpoint'
import { isRecord } from '../../../shared/domain/validation'

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo'
const SCOPES = ['openid', 'email', 'profile']

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleAuthError'
  }
}

interface GoogleUserInfo {
  id: string
  email: string
  verified_email: boolean
  name?: string
}

/** Único punto de validación de forma para la respuesta del userinfo endpoint de Google — de aquí en adelante el tipo se propaga sin recastear. */
function parseGoogleUserInfo(value: unknown): GoogleUserInfo {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.email !== 'string' ||
    typeof value.verified_email !== 'boolean' ||
    (value.name !== undefined && typeof value.name !== 'string')
  ) {
    throw new GoogleAuthError('Google userinfo response does not match the expected shape')
  }
  return {
    id: value.id,
    email: value.email,
    verified_email: value.verified_email,
    name: value.name,
  }
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
    const profile = await this.fetchUserInfo(tokens.accessToken)

    if (!profile.verified_email) {
      throw new GoogleAuthError('Google account email is not verified')
    }

    return {
      email: profile.email.toLowerCase(),
      name: profile.name ?? null,
      oauth: {
        provider: 'google',
        providerAccountId: profile.id,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      },
    }
  }

  private async exchangeCodeForTokens(code: string): Promise<GoogleTokens> {
    try {
      return await exchangeCodeForGoogleTokens({
        code,
        clientId: this.options.clientId,
        clientSecret: this.options.clientSecret,
        redirectUri: this.options.redirectUri,
      })
    } catch (error) {
      if (error instanceof GoogleTokenEndpointError) {
        throw new GoogleAuthError(error.message)
      }
      throw error
    }
  }

  private async fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    let response: Response
    try {
      response = await fetch(USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    } catch {
      throw new GoogleAuthError('Network error while fetching Google user info')
    }

    if (!response.ok) {
      throw new GoogleAuthError('Failed to fetch Google user info')
    }

    return parseGoogleUserInfo(await response.json())
  }
}
