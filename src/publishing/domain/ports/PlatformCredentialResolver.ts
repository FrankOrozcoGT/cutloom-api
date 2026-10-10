export class NoPlatformConnectionError extends Error {
  constructor(platform: string) {
    super(`Organization has no connected ${platform} account`)
    this.name = 'NoPlatformConnectionError'
  }
}

export class PlatformAccountTokenNotFoundError extends Error {
  constructor(platformAccountId: string) {
    super(`No OAuth token found for platform account: ${platformAccountId}`)
    this.name = 'PlatformAccountTokenNotFoundError'
  }
}

/**
 * Abstrae "dar un access token vigente para una cuenta de plataforma específica, refrescando y
 * persistiendo si hace falta" sin que el caller conozca la forma concreta de cada proveedor
 * OAuth. Recibe platformAccountId explícito (no organizationId): un video ya agendado con la
 * cuenta A debe seguir publicándose con la cuenta A aunque mientras tanto la organización haya
 * conectado una cuenta B distinta — resolver por "la cuenta activa ahora" perdería esa garantía.
 * Implementado una sola vez por OAuthPlatformCredentialResolver, instanciado por plataforma en
 * el composition root.
 */
export interface PlatformCredentialResolver {
  /** Lanza PlatformAccountTokenNotFoundError si esta cuenta nunca tuvo un token (no debería ocurrir: toda PlatformAccount se crea junto con su token en el mismo OAuth callback). */
  resolveAccessToken(platformAccountId: string): Promise<string>
}
