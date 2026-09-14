import { isRecord } from '../../domain/validation'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

export interface GoogleTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  /** Solo presente en el intercambio inicial (authorization_code) con scope openid — ausente al usar refresh_token o sin ese scope. */
  idToken: string | null
}

/** Único punto de validación de forma para la respuesta del token endpoint de Google — de aquí en adelante el tipo se propaga sin recastear. */
function parseGoogleTokenResponse(value: unknown): GoogleTokens {
  if (
    !isRecord(value) ||
    typeof value.access_token !== 'string' ||
    typeof value.expires_in !== 'number' ||
    (value.refresh_token !== undefined && typeof value.refresh_token !== 'string') ||
    (value.id_token !== undefined && typeof value.id_token !== 'string')
  ) {
    throw new Error('Google token endpoint response does not match the expected shape')
  }
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token ?? null,
    expiresAt: new Date(Date.now() + value.expires_in * 1000),
    idToken: value.id_token ?? null,
  }
}

export interface ExchangeCodeInput {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
}

export interface RefreshTokenInput {
  refreshToken: string
  clientId: string
  clientSecret: string
}

/**
 * Intercambio de code/refresh_token por tokens contra el endpoint de Google — mecanismo
 * idéntico entre distintos flujos OAuth de Google que puedan coexistir en el backend (login
 * de identity, permiso de subida de publishing, etc.), solo cambia el scope/redirect_uri, que
 * ya son parámetros de la capa de arriba, no de este mecanismo de bajo nivel.
 */
export class GoogleTokenEndpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleTokenEndpointError'
  }
}

export async function exchangeCodeForGoogleTokens(input: ExchangeCodeInput): Promise<GoogleTokens> {
  let response: Response
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
      }),
    })
  } catch {
    throw new GoogleTokenEndpointError('Network error while exchanging authorization code with Google')
  }

  if (!response.ok) {
    throw new GoogleTokenEndpointError('Failed to exchange authorization code with Google')
  }

  return parseGoogleTokenResponse(await response.json())
}

export async function refreshGoogleAccessToken(input: RefreshTokenInput): Promise<GoogleTokens> {
  let response: Response
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: input.refreshToken,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        grant_type: 'refresh_token',
      }),
    })
  } catch {
    throw new GoogleTokenEndpointError('Network error while refreshing Google access token')
  }

  if (!response.ok) {
    throw new GoogleTokenEndpointError('Failed to refresh Google access token')
  }

  return parseGoogleTokenResponse(await response.json())
}
