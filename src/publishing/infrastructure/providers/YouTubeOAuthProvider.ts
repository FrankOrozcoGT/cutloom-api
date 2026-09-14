import {
  exchangeCodeForGoogleTokens,
  GoogleTokenEndpointError,
  refreshGoogleAccessToken,
} from '../../../shared/infrastructure/providers/GoogleTokenEndpoint'
import type { YouTubeOAuthPort, YouTubeTokens } from '../../domain/ports/YouTubeOAuthPort'

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload']

export class YouTubeOAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YouTubeOAuthError'
  }
}

export interface YouTubeOAuthProviderOptions {
  clientId: string
  clientSecret: string
  /** Debe coincidir exactamente con un redirect URI autorizado en Google Cloud Console para este client, distinto del de login. */
  redirectUri: string
}

/** Envuelve cualquier fallo del token endpoint de Google en el error de dominio de este provider — un solo punto de mapeo en vez de repetir el mismo try/catch en cada método público. */
async function wrapGoogleTokenEndpointError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof GoogleTokenEndpointError) {
      throw new YouTubeOAuthError(error.message)
    }
    throw error
  }
}

/**
 * OAuth 2.0 separado del de identity (login): mismo GOOGLE_CLIENT_ID/SECRET pero
 * redirect_uri y scope distintos (youtube.upload). access_type=offline + prompt=consent
 * para maximizar la chance de recibir refresh_token, aunque Google no lo garantiza en
 * reconexiones (ver HandleYouTubeOAuthCallbackUseCase). El intercambio de code/refresh_token
 * en sí vive en shared/GoogleTokenEndpoint (mecanismo idéntico al de identity/login).
 */
export class YouTubeOAuthProvider implements YouTubeOAuthPort {
  constructor(private readonly options: YouTubeOAuthProviderOptions) {}

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

  async exchangeCodeForTokens(code: string): Promise<YouTubeTokens> {
    return wrapGoogleTokenEndpointError(async () => {
      const tokens = await exchangeCodeForGoogleTokens({
        code,
        clientId: this.options.clientId,
        clientSecret: this.options.clientSecret,
        redirectUri: this.options.redirectUri,
      })
      return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt }
    })
  }

  async refreshAccessToken(refreshToken: string): Promise<Omit<YouTubeTokens, 'refreshToken'>> {
    return wrapGoogleTokenEndpointError(async () => {
      const tokens = await refreshGoogleAccessToken({
        refreshToken,
        clientId: this.options.clientId,
        clientSecret: this.options.clientSecret,
      })
      return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt }
    })
  }
}
