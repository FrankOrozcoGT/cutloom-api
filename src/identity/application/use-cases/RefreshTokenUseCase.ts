import type { TokenBlacklistRepository } from '../../domain/ports/TokenBlacklistRepository'
import { InvalidTokenError } from '../../domain/ports/TokenService'
import type { TokenService, TokenPair } from '../../domain/ports/TokenService'
import type { UserRepository } from '../../domain/ports/UserRepository'

export class RefreshTokenUseCase {
  constructor(
    private readonly tokenService: TokenService,
    private readonly tokenBlacklistRepository: TokenBlacklistRepository,
    private readonly userRepository: UserRepository,
  ) {}

  async execute(refreshToken: string): Promise<TokenPair> {
    const payload = await this.tokenService.verifyRefreshToken(refreshToken)

    const isBlacklisted = await this.tokenBlacklistRepository.isBlacklisted(refreshToken)
    if (isBlacklisted) {
      throw new InvalidTokenError('Token invalidated')
    }

    const user = await this.userRepository.findById(payload.userId)
    if (!user) {
      throw new InvalidTokenError('User no longer exists')
    }

    await this.tokenBlacklistRepository.add(refreshToken, new Date(payload.exp * 1000))

    return this.tokenService.generateTokenPair({
      userId: user.id,
      organizationId: payload.organizationId,
    })
  }
}
