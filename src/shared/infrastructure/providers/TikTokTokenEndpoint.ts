import { isRecord } from '../../domain/validation'

const TOKEN_ENDPOINT = 'https://open.tiktokapis.com/v2/oauth/token/'

export interface TikTokTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  refreshExpiresAt: Date | null
  openId: string
  scope: string | null
}

/** Único punto de validación de forma para la respuesta del token endpoint de TikTok — de aquí en adelante el tipo se propaga sin recastear. */
function parseTikTokTokenResponse(value: unknown): TikTokTokens {
  if (
    !isRecord(value) ||
    typeof value.access_token !== 'string' ||
    typeof value.expires_in !== 'number' ||
    typeof value.open_id !== 'string' ||
    (value.refresh_token !== undefined && typeof value.refresh_token !== 'string') ||
    (value.refresh_expires_in !== undefined && typeof value.refresh_expires_in !== 'number') ||
    (value.scope !== undefined && typeof value.scope !== 'string')
  ) {
    throw new Error('TikTok token endpoint response does not match the expected shape')
  }
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token ?? null,
    expiresAt: new Date(Date.now() + value.expires_in * 1000),
    refreshExpiresAt: value.refresh_expires_in ? new Date(Date.now() + value.refresh_expires_in * 1000) : null,
    openId: value.open_id,
    scope: value.scope ?? null,
  }
}

export interface ExchangeCodeInput {
  code: string
  clientKey: string
  clientSecret: string
  redirectUri: string
}

export interface RefreshTokenInput {
  refreshToken: string
  clientKey: string
  clientSecret: string
}

/**
 * Intercambio de code/refresh_token por tokens contra el endpoint de TikTok — proveedor
 * totalmente distinto de Google (client_key/client_secret en vez de client_id/client_secret),
 * así que no se puede reutilizar GoogleTokenEndpoint pese a la simetría de propósito. Web usa
 * el mismo modelo confidential-client que YouTube (sin PKCE): code_verifier solo aplica a
 * mobile/desktop apps según la doc de TikTok Login Kit v2, no a este flujo server-side.
 */
export class TikTokTokenEndpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TikTokTokenEndpointError'
  }
}

export async function exchangeCodeForTikTokTokens(input: ExchangeCodeInput): Promise<TikTokTokens> {
  let response: Response
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams({
        client_key: input.clientKey,
        client_secret: input.clientSecret,
        code: input.code,
        grant_type: 'authorization_code',
        redirect_uri: input.redirectUri,
      }),
    })
  } catch {
    throw new TikTokTokenEndpointError('Network error while exchanging authorization code with TikTok')
  }

  if (!response.ok) {
    throw new TikTokTokenEndpointError('Failed to exchange authorization code with TikTok')
  }

  return parseTikTokTokenResponse(await response.json())
}

export async function refreshTikTokAccessToken(input: RefreshTokenInput): Promise<TikTokTokens> {
  let response: Response
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams({
        client_key: input.clientKey,
        client_secret: input.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
      }),
    })
  } catch {
    throw new TikTokTokenEndpointError('Network error while refreshing TikTok access token')
  }

  if (!response.ok) {
    throw new TikTokTokenEndpointError('Failed to refresh TikTok access token')
  }

  return parseTikTokTokenResponse(await response.json())
}
