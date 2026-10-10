export interface PlatformOAuthTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  /** Solo algunas plataformas (TikTok) emiten un refresh_token con vencimiento propio — null en las que no. */
  refreshExpiresAt: Date | null
  /** Id real y estable de la cuenta en la plataforma (YouTube: channelId; TikTok: openId) — clave de unicidad de PlatformAccount, nunca inventado. */
  externalAccountId: string
  /** Datos de cuenta específicos de la plataforma, solo presentes en el intercambio inicial del code — shape distinto por proveedor (YouTube: { googleEmail, channelTitle }; TikTok: { openId, displayName }), opaco para el caller. */
  platformAccountInfo: Record<string, unknown> | null
}

/**
 * Puerto de OAuth único — YouTubeOAuthProvider y TikTokOAuthProvider son los únicos dos puntos
 * del sistema que conocen el nombre de su plataforma en este flujo. HandleOAuthCallbackUseCase
 * y el resto del bounded context son genéricos sobre esta interfaz.
 */
export interface PlatformOAuthPort {
  buildAuthorizationUrl(state: string): string
  exchangeCodeForTokens(code: string): Promise<PlatformOAuthTokens>
  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date; refreshExpiresAt: Date | null }>
}
