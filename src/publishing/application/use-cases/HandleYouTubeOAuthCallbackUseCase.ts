import type { YouTubeOAuthToken } from '../../domain/entities/YouTubeOAuthToken'
import type { TokenEncryptionService } from '../../domain/ports/TokenEncryptionService'
import type { YouTubeOAuthTokenRepository } from '../../domain/ports/YouTubeOAuthTokenRepository'
import type { YouTubeOAuthPort } from '../../domain/ports/YouTubeOAuthPort'

export class YouTubeConsentDeniedError extends Error {
  constructor() {
    super('User denied YouTube OAuth consent')
    this.name = 'YouTubeConsentDeniedError'
  }
}

/** Google devolvió un error distinto de access_denied (ej. server_error, temporarily_unavailable, invalid_scope) — un fallo real de Google, no un rechazo del usuario. Se distingue explícitamente para no mostrarle al usuario "denegaste el permiso" cuando el problema es de infraestructura de Google. */
export class YouTubeOAuthProviderError extends Error {
  constructor(googleError: string) {
    super(`Google OAuth callback returned an unexpected error: ${googleError}`)
    this.name = 'YouTubeOAuthProviderError'
  }
}

/** Falta el code sin que Google haya reportado ningún error explícito — respuesta inesperada del callback, tampoco es un rechazo del usuario. */
export class MissingAuthorizationCodeError extends Error {
  constructor() {
    super('YouTube OAuth callback is missing the authorization code, with no error reported by Google')
    this.name = 'MissingAuthorizationCodeError'
  }
}

export interface HandleYouTubeOAuthCallbackInput {
  organizationId: string
  code?: string
  error?: string
}

export class HandleYouTubeOAuthCallbackUseCase {
  constructor(
    private readonly youTubeOAuthProvider: YouTubeOAuthPort,
    private readonly tokenRepository: YouTubeOAuthTokenRepository,
    private readonly encryptionService: TokenEncryptionService,
  ) {}

  async execute(input: HandleYouTubeOAuthCallbackInput): Promise<YouTubeOAuthToken> {
    if (input.error === 'access_denied') {
      throw new YouTubeConsentDeniedError()
    }
    if (input.error) {
      throw new YouTubeOAuthProviderError(input.error)
    }
    if (!input.code) {
      throw new MissingAuthorizationCodeError()
    }

    const tokens = await this.youTubeOAuthProvider.exchangeCodeForTokens(input.code)

    return this.tokenRepository.upsert({
      organizationId: input.organizationId,
      encryptedAccessToken: this.encryptionService.encrypt(tokens.accessToken),
      // null si Google no devolvió refresh_token en esta reconexión — el repositorio
      // conserva el refresh_token existente en ese caso en vez de perderlo (ver upsert).
      encryptedRefreshToken: tokens.refreshToken ? this.encryptionService.encrypt(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt,
      googleEmail: tokens.googleEmail,
      channelTitle: tokens.channelTitle,
    })
  }
}
