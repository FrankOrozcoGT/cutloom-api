import {
  exchangeCodeForTikTokTokens,
  refreshTikTokAccessToken,
  TikTokTokenEndpointError,
} from '../../../shared/infrastructure/providers/TikTokTokenEndpoint'
import type { PlatformOAuthPort, PlatformOAuthTokens } from '../../domain/ports/PlatformOAuthPort'
import { isRecord } from '../../../shared/domain/validation'

const AUTHORIZATION_ENDPOINT = 'https://www.tiktok.com/v2/auth/authorize/'
const USER_INFO_ENDPOINT = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name'
// video.upload + video.publish: TikTok las acepta juntas en el mismo authorization flow.
// user.info.basic: necesario para consultar display_name vía user/info (mostrar "conectado como X").
const SCOPES = ['user.info.basic', 'video.upload', 'video.publish']

/** Único punto de validación de forma para la respuesta de user/info — de aquí en adelante el tipo se propaga sin recastear. */
function parseDisplayName(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.user)) return null
  const { user } = value.data
  return typeof user.display_name === 'string' ? user.display_name : null
}

async function fetchDisplayName(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(USER_INFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok) return null
    return parseDisplayName(await response.json())
  } catch {
    return null
  }
}

export class TikTokOAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TikTokOAuthError'
  }
}

export interface TikTokOAuthProviderOptions {
  clientKey: string
  clientSecret: string
  /** Debe coincidir exactamente con el redirect URI registrado en el portal de TikTok for Developers para esta app. */
  redirectUri: string
}

/** Envuelve cualquier fallo del token endpoint de TikTok en el error de dominio de este provider — un solo punto de mapeo en vez de repetir el mismo try/catch en cada método público. */
async function wrapTikTokTokenEndpointError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof TikTokTokenEndpointError) {
      throw new TikTokOAuthError(error.message)
    }
    throw error
  }
}

/**
 * OAuth 2.0 separado del flujo de identity (que solo soporta Google): client_key/client_secret
 * propios, authorize en tiktok.com, token endpoint en open.tiktokapis.com. Web es un
 * confidential client (igual que YouTube) — TikTok exige PKCE solo para apps desktop/iOS/Android,
 * no para este flujo server-side (confirmado en la doc de Login Kit v2). El intercambio de
 * code/refresh_token en sí vive en shared/TikTokTokenEndpoint (mecanismo de bajo nivel).
 */
export class TikTokOAuthProvider implements PlatformOAuthPort {
  constructor(private readonly options: TikTokOAuthProviderOptions) {}

  buildAuthorizationUrl(state: string): string {
    const url = new URL(AUTHORIZATION_ENDPOINT)
    url.searchParams.set('client_key', this.options.clientKey)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', SCOPES.join(','))
    url.searchParams.set('redirect_uri', this.options.redirectUri)
    url.searchParams.set('state', state)
    // Sin esto, TikTok puede saltear la pantalla de autorización si ya hay una sesión válida
    // en el navegador, reusando la última cuenta usada en vez de dejar elegir — forzamos a que
    // siempre se muestre, para no quedar pegados a una cuenta de sesión vieja.
    url.searchParams.set('disable_auto_auth', '1')
    return url.toString()
  }

  async exchangeCodeForTokens(code: string): Promise<PlatformOAuthTokens> {
    return wrapTikTokTokenEndpointError(async () => {
      const tokens = await exchangeCodeForTikTokTokens({
        code,
        clientKey: this.options.clientKey,
        clientSecret: this.options.clientSecret,
        redirectUri: this.options.redirectUri,
      })
      const displayName = await fetchDisplayName(tokens.accessToken)
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
        externalAccountId: tokens.openId,
        platformAccountInfo: { openId: tokens.openId, displayName },
      }
    })
  }

  async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresAt: Date; refreshExpiresAt: Date | null }> {
    return wrapTikTokTokenEndpointError(async () => {
      const tokens = await refreshTikTokAccessToken({
        refreshToken,
        clientKey: this.options.clientKey,
        clientSecret: this.options.clientSecret,
      })
      return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, refreshExpiresAt: tokens.refreshExpiresAt }
    })
  }
}
