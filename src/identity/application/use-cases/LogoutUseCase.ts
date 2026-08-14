import type { TokenBlacklistRepository } from '../../domain/ports/TokenBlacklistRepository'
import { InvalidTokenError } from '../../domain/ports/TokenService'
import type { TokenService } from '../../domain/ports/TokenService'

export class LogoutUseCase {
  constructor(
    private readonly tokenService: TokenService,
    private readonly tokenBlacklistRepository: TokenBlacklistRepository,
  ) {}

  async execute(refreshToken: string): Promise<void> {
    try {
      const payload = await this.tokenService.verifyRefreshToken(refreshToken)
      await this.tokenBlacklistRepository.add(refreshToken, new Date(payload.exp * 1000))
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        return
      }
      throw error
    }
  }
}
