import { SignJWT, jwtVerify, errors as joseErrors } from 'jose'
import { InvalidTokenError } from '../../domain/ports/TokenService'
import type { TokenPair, TokenPayload, TokenService, VerifiedTokenPayload } from '../../domain/ports/TokenService'

const ALGORITHM = 'HS256'
const MIN_SECRET_LENGTH = 32

export interface JwtTokenServiceOptions {
  secret: string
  accessTokenExpiresIn: string
  refreshTokenExpiresIn: string
}

export class JwtTokenService implements TokenService {
  private readonly secretKey: Uint8Array
  private readonly accessTokenExpiresIn: string
  private readonly refreshTokenExpiresIn: string

  constructor(options: JwtTokenServiceOptions) {
    if (options.secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
    }

    this.secretKey = new TextEncoder().encode(options.secret)
    this.accessTokenExpiresIn = options.accessTokenExpiresIn
    this.refreshTokenExpiresIn = options.refreshTokenExpiresIn
  }

  async generateTokenPair(payload: TokenPayload): Promise<TokenPair> {
    const [accessToken, refreshToken] = await Promise.all([
      this.sign(payload, this.accessTokenExpiresIn),
      this.sign(payload, this.refreshTokenExpiresIn),
    ])

    return { accessToken, refreshToken }
  }

  async verifyAccessToken(token: string): Promise<VerifiedTokenPayload> {
    return this.verify(token)
  }

  async verifyRefreshToken(token: string): Promise<VerifiedTokenPayload> {
    return this.verify(token)
  }

  private async sign(payload: TokenPayload, expiresIn: string): Promise<string> {
    return new SignJWT({ userId: payload.userId, organizationId: payload.organizationId })
      .setProtectedHeader({ alg: ALGORITHM })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(this.secretKey)
  }

  private async verify(token: string): Promise<VerifiedTokenPayload> {
    try {
      const { payload } = await jwtVerify(token, this.secretKey, { algorithms: [ALGORITHM] })

      if (typeof payload.userId !== 'string' || typeof payload.organizationId !== 'string' || !payload.exp) {
        throw new InvalidTokenError()
      }

      return { userId: payload.userId, organizationId: payload.organizationId, exp: payload.exp }
    } catch (error) {
      if (error instanceof joseErrors.JOSEError) {
        throw new InvalidTokenError()
      }
      throw error
    }
  }
}
