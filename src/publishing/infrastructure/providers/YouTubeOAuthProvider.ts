import {
  exchangeCodeForGoogleTokens,
  extractEmailFromIdToken,
  GoogleTokenEndpointError,
  refreshGoogleAccessToken,
} from '../../../shared/infrastructure/providers/GoogleTokenEndpoint'
import type { YouTubeOAuthPort, YouTubeTokens } from '../../domain/ports/YouTubeOAuthPort'
import { isRecord } from '../../../shared/domain/validation'

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const CHANNELS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true'
// email/openid: solo para mostrar "conectado como X" en el frontend, nunca se usan para
// autorizar nada. youtube.readonly: necesario para consultar el nombre del canal propio vía
// channels.list — youtube.upload por sí solo no autoriza ese endpoint de lectura.
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'openid',
  'email',
]

/** Único punto de validación de forma para la respuesta de channels.list — de aquí en adelante el tipo se propaga sin recastear. */
function parseChannelTitle(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length === 0) return null
  const channel: unknown = value.items[0]
  if (!isRecord(channel) || !isRecord(channel.snippet) || typeof channel.snippet.title !== 'string') return null
  return channel.snippet.title
}

async function fetchChannelTitle(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(CHANNELS_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok) return null
    return parseChannelTitle(await response.json())
  } catch {
    return null
  }
}

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
      const googleEmail = tokens.idToken ? extractEmailFromIdToken(tokens.idToken) : null
      const channelTitle = await fetchChannelTitle(tokens.accessToken)
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        googleEmail,
        channelTitle,
      }
    })
  }

  async refreshAccessToken(
    refreshToken: string,
  ): Promise<Omit<YouTubeTokens, 'refreshToken' | 'googleEmail' | 'channelTitle'>> {
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
