export class InvalidTokenError extends Error {
  constructor(message = 'Invalid or expired token') {
    super(message)
    this.name = 'InvalidTokenError'
  }
}

export interface TokenPayload {
  userId: string
  organizationId: string
}

export interface VerifiedTokenPayload extends TokenPayload {
  exp: number
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

export interface TokenService {
  generateTokenPair(payload: TokenPayload): Promise<TokenPair>
  verifyAccessToken(token: string): Promise<VerifiedTokenPayload>
  verifyRefreshToken(token: string): Promise<VerifiedTokenPayload>
}
