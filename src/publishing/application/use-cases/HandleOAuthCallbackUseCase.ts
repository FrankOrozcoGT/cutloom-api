import type { PlatformOAuthToken } from '../../domain/entities/PlatformOAuthToken'
import type { VideoPlatform } from '../../domain/entities/PublishedVideo'
import type { TokenEncryptionService } from '../../domain/ports/TokenEncryptionService'
import type { PlatformOAuthTokenRepository } from '../../domain/ports/PlatformOAuthTokenRepository'
import type { PlatformOAuthPort } from '../../domain/ports/PlatformOAuthPort'
import type { PlatformAccountRepository } from '../../domain/ports/PlatformAccountRepository'
import type { ActivePlatformAccountRepository } from '../../domain/ports/ActivePlatformAccountRepository'

export class OAuthConsentDeniedError extends Error {
  constructor(platform: string) {
    super(`User denied ${platform} OAuth consent`)
    this.name = 'OAuthConsentDeniedError'
  }
}

/** La plataforma devolvió un error distinto de access_denied — un fallo real de su infraestructura, no un rechazo del usuario. Se distingue explícitamente para no mostrarle al usuario "denegaste el permiso" cuando el problema es del proveedor. */
export class OAuthProviderError extends Error {
  constructor(platform: string, providerError: string) {
    super(`${platform} OAuth callback returned an unexpected error: ${providerError}`)
    this.name = 'OAuthProviderError'
  }
}

/** Falta el code sin que la plataforma haya reportado ningún error explícito — respuesta inesperada del callback, tampoco es un rechazo del usuario. */
export class MissingAuthorizationCodeError extends Error {
  constructor(platform: string) {
    super(`${platform} OAuth callback is missing the authorization code, with no error reported by the platform`)
    this.name = 'MissingAuthorizationCodeError'
  }
}

export interface HandleOAuthCallbackInput {
  organizationId: string
  code?: string
  error?: string
}

/**
 * Caso de uso único de intercambio de code por tokens — un mismo flujo para cualquier
 * plataforma, instanciado una vez por proveedor con su propio PlatformOAuthPort (ver
 * publishingComposition.ts). Primero resuelve/crea la PlatformAccount por su externalAccountId
 * real (nunca duplica una cuenta ya conectada antes, aunque la organización la haya
 * desconectado y reconectado), cifra y hace upsert del token contra esa cuenta, y por último
 * marca esa cuenta como la activa de la organización para esta plataforma — los
 * PublishedVideo/tokens de una cuenta anterior nunca se pierden ni se sobrescriben, solo dejan
 * de ser "la cuenta en uso ahora".
 */
export class HandleOAuthCallbackUseCase {
  constructor(
    private readonly platform: VideoPlatform,
    private readonly oauthProvider: PlatformOAuthPort,
    private readonly platformAccountRepository: PlatformAccountRepository,
    private readonly activePlatformAccountRepository: ActivePlatformAccountRepository,
    private readonly tokenRepository: PlatformOAuthTokenRepository,
    private readonly encryptionService: TokenEncryptionService,
  ) {}

  async execute(input: HandleOAuthCallbackInput): Promise<PlatformOAuthToken> {
    if (input.error === 'access_denied') {
      throw new OAuthConsentDeniedError(this.platform)
    }
    if (input.error) {
      throw new OAuthProviderError(this.platform, input.error)
    }
    if (!input.code) {
      throw new MissingAuthorizationCodeError(this.platform)
    }

    const tokens = await this.oauthProvider.exchangeCodeForTokens(input.code)

    const account = await this.platformAccountRepository.findOrCreate({
      organizationId: input.organizationId,
      platform: this.platform,
      externalAccountId: tokens.externalAccountId,
      platformAccountInfo: tokens.platformAccountInfo,
    })

    const token = await this.tokenRepository.upsert({
      platformAccountId: account.id,
      encryptedAccessToken: this.encryptionService.encrypt(tokens.accessToken),
      // null si la plataforma no devolvió refresh_token en esta reconexión — el repositorio
      // conserva el refresh_token existente en ese caso en vez de perderlo.
      encryptedRefreshToken: tokens.refreshToken ? this.encryptionService.encrypt(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
    })

    await this.activePlatformAccountRepository.setActivePlatformAccount(input.organizationId, this.platform, account.id)

    return token
  }
}
