import type { TokenEncryptionService } from '../../domain/ports/TokenEncryptionService'
import type { PlatformOAuthTokenRepository } from '../../domain/ports/PlatformOAuthTokenRepository'
import type { PlatformOAuthPort } from '../../domain/ports/PlatformOAuthPort'
import { PlatformAccountTokenNotFoundError, type PlatformCredentialResolver } from '../../domain/ports/PlatformCredentialResolver'

/**
 * Única implementación de PlatformCredentialResolver — un mismo adaptador para cualquier
 * plataforma OAuth, instanciado una vez por proveedor (ver publishingComposition.ts) sobre la
 * tabla compartida platform_oauth_tokens, resolviendo siempre por platformAccountId explícito.
 */
export class OAuthPlatformCredentialResolver implements PlatformCredentialResolver {
  constructor(
    private readonly tokenRepository: PlatformOAuthTokenRepository,
    private readonly encryptionService: TokenEncryptionService,
    private readonly oauthProvider: PlatformOAuthPort,
  ) {}

  async resolveAccessToken(platformAccountId: string): Promise<string> {
    const token = await this.tokenRepository.findByPlatformAccountId(platformAccountId)
    if (!token) throw new PlatformAccountTokenNotFoundError(platformAccountId)

    if (!token.isExpired()) {
      return this.encryptionService.decrypt(token.encryptedAccessToken)
    }

    const refreshToken = token.encryptedRefreshToken ? this.encryptionService.decrypt(token.encryptedRefreshToken) : null
    if (!refreshToken) {
      return this.encryptionService.decrypt(token.encryptedAccessToken)
    }

    const refreshed = await this.oauthProvider.refreshAccessToken(refreshToken)
    await this.tokenRepository.upsert({
      platformAccountId,
      encryptedAccessToken: this.encryptionService.encrypt(refreshed.accessToken),
      encryptedRefreshToken: token.encryptedRefreshToken,
      expiresAt: refreshed.expiresAt,
      refreshExpiresAt: refreshed.refreshExpiresAt ?? token.refreshExpiresAt,
    })
    return refreshed.accessToken
  }
}
