import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  AuthenticateUserUseCase,
  EmailExistsLocalError,
} from '../../application/use-cases/AuthenticateUserUseCase'
import type { LogoutUseCase } from '../../application/use-cases/LogoutUseCase'
import type { RefreshTokenUseCase } from '../../application/use-cases/RefreshTokenUseCase'
import { EmailAlreadyExistsError } from '../../domain/ports/UserRepository'
import { InvalidCredentialsError, EmailExistsWithGoogleError } from '../../domain/ports/IdentityProvider'
import { GoogleAuthError, type GoogleIdentityProvider } from '../providers/GoogleIdentityProvider'
import { InvalidEmailError } from '../../domain/value-objects/Email'
import { WeakPasswordError } from '../../domain/value-objects/Password'
import { InvalidTokenError } from '../../domain/ports/TokenService'
import type { User } from '../../domain/entities/User'
import type { EntitlementsReader } from '../../domain/ports/EntitlementsReader'
import type { YouTubeConnectionReader } from '../../domain/ports/YouTubeConnectionReader'
import { isSafeReturnTo, buildOAuthCallbackUrl } from '../../../shared/infrastructure/http/oauthCallbackRedirect'

export interface EmailPasswordBody {
  email: string
  password: string
}

const REFRESH_TOKEN_COOKIE = 'refreshToken'
const REFRESH_TOKEN_COOKIE_PATH = '/api/auth/refresh'
const OAUTH_STATE_COOKIE = 'oauth_state'
const OAUTH_STATE_COOKIE_PATH = '/api/auth/google'
const OAUTH_RETURN_TO_COOKIE = 'oauth_return_to'

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: REFRESH_TOKEN_COOKIE_PATH,
  }
}

function stateCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const, // Google's redirect back is a top-level cross-site GET; 'strict' would drop the cookie.
    path: OAUTH_STATE_COOKIE_PATH,
    maxAge: 60 * 10,
  }
}

function serializeUser(user: User) {
  return user.toJSON()
}

export class AuthController {
  constructor(
    private readonly authenticateUserUseCase: AuthenticateUserUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly refreshTokenUseCase: RefreshTokenUseCase,
    private readonly googleProvider: GoogleIdentityProvider,
    private readonly frontendUrl: string,
    private readonly entitlementsReader: EntitlementsReader,
    private readonly youTubeConnectionReader: YouTubeConnectionReader,
  ) {}

  async register(req: FastifyRequest<{ Body: EmailPasswordBody }>, reply: FastifyReply) {
    return this.authenticateLocal(req, reply, 'register', 201)
  }

  async login(req: FastifyRequest<{ Body: EmailPasswordBody }>, reply: FastifyReply) {
    return this.authenticateLocal(req, reply, 'login', 200)
  }

  private async authenticateLocal(
    req: FastifyRequest<{ Body: EmailPasswordBody }>,
    reply: FastifyReply,
    intent: 'register' | 'login',
    successStatus: number,
  ) {
    try {
      const { email, password } = req.body
      const result = await this.authenticateUserUseCase.execute({
        provider: 'local',
        intent,
        credentials: { email, password },
      })

      reply.setCookie(REFRESH_TOKEN_COOKIE, result.tokens.refreshToken, cookieOptions())
      return reply.status(successStatus).send({
        user: serializeUser(result.user),
        accessToken: result.tokens.accessToken,
        isNewUser: result.isNewUser,
      })
    } catch (error) {
      return this.handleError(error, reply)
    }
  }

  async googleStart(req: FastifyRequest, reply: FastifyReply) {
    const { returnTo } = req.query as { returnTo?: string }

    const state = crypto.randomUUID()
    reply.setCookie(OAUTH_STATE_COOKIE, state, stateCookieOptions())

    if (returnTo && isSafeReturnTo(returnTo)) {
      reply.setCookie(OAUTH_RETURN_TO_COOKIE, returnTo, stateCookieOptions())
    }

    return reply.redirect(this.googleProvider.buildAuthorizationUrl(state))
  }

  async googleCallback(req: FastifyRequest, reply: FastifyReply) {
    const { code, state, error: googleError } = req.query as {
      code?: string
      state?: string
      error?: string
    }
    const expectedState = req.cookies[OAUTH_STATE_COOKIE]
    reply.clearCookie(OAUTH_STATE_COOKIE, stateCookieOptions())

    const returnTo = req.cookies[OAUTH_RETURN_TO_COOKIE]
    reply.clearCookie(OAUTH_RETURN_TO_COOKIE, stateCookieOptions())

    if (googleError || !code || !state || state !== expectedState) {
      return this.redirectWithError(reply, 'GOOGLE_AUTH_FAILED', returnTo)
    }

    try {
      const result = await this.authenticateUserUseCase.execute({
        provider: 'google',
        credentials: { code },
      })

      reply.setCookie(REFRESH_TOKEN_COOKIE, result.tokens.refreshToken, cookieOptions())
      return reply.redirect(this.buildCallbackUrl({ isNewUser: String(result.isNewUser) }, returnTo))
    } catch (error) {
      if (error instanceof EmailExistsWithGoogleError) {
        return this.redirectWithError(reply, 'EMAIL_EXISTS_GOOGLE', returnTo)
      }
      if (error instanceof EmailExistsLocalError) {
        return this.redirectWithError(reply, 'EMAIL_EXISTS_LOCAL', returnTo)
      }
      if (error instanceof GoogleAuthError) {
        return this.redirectWithError(reply, 'GOOGLE_AUTH_FAILED', returnTo)
      }
      // Cualquier otro fallo imprevisto: esto es una navegación real del navegador
      // (redirect de Google), no una llamada fetch del frontend — nunca debe mostrarle
      // JSON crudo al usuario. Se loguea el error real y se redirige con un código
      // genérico para que el frontend lo muestre.
      req.log.error(error, 'Unexpected error in Google OAuth callback')
      return this.redirectWithError(reply, 'UNEXPECTED_ERROR', returnTo)
    }
  }

  private buildCallbackUrl(params: Record<string, string>, returnTo: string | undefined): string {
    return buildOAuthCallbackUrl(this.frontendUrl, '/auth/callback', params, returnTo)
  }

  private redirectWithError(reply: FastifyReply, error: string, returnTo?: string) {
    return reply.redirect(this.buildCallbackUrl({ error }, returnTo))
  }

  async logout(req: FastifyRequest, reply: FastifyReply) {
    const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE]

    if (refreshToken) {
      await this.logoutUseCase.execute(refreshToken)
    }

    reply.clearCookie(REFRESH_TOKEN_COOKIE, cookieOptions())
    return reply.status(204).send()
  }

  async me(req: FastifyRequest, reply: FastifyReply) {
    if (!req.user) {
      return reply.status(401).send({ error: 'MISSING_ACCESS_TOKEN' })
    }

    const [entitlements, youtube] = await Promise.all([
      req.organizationId ? this.entitlementsReader.findByOrganizationId(req.organizationId) : Promise.resolve([]),
      req.organizationId
        ? this.youTubeConnectionReader.getStatus(req.organizationId)
        : Promise.resolve({ connected: false, googleEmail: null, channelTitle: null }),
    ])

    return reply.status(200).send({
      user: serializeUser(req.user),
      organizationId: req.organizationId ?? null,
      entitlements,
      youtubeConnected: youtube.connected,
      youtubeGoogleEmail: youtube.googleEmail,
      youtubeChannelTitle: youtube.channelTitle,
    })
  }

  async refresh(req: FastifyRequest, reply: FastifyReply) {
    try {
      const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE]

      if (!refreshToken) {
        return reply.status(401).send({ error: 'MISSING_REFRESH_TOKEN' })
      }

      const tokens = await this.refreshTokenUseCase.execute(refreshToken)

      reply.setCookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, cookieOptions())
      return reply.status(200).send({ accessToken: tokens.accessToken })
    } catch (error) {
      return this.handleError(error, reply)
    }
  }

  private handleError(error: unknown, reply: FastifyReply) {
    if (error instanceof EmailAlreadyExistsError || error instanceof EmailExistsLocalError) {
      return reply.status(409).send({ error: 'EMAIL_EXISTS' })
    }
    if (error instanceof EmailExistsWithGoogleError) {
      return reply.status(409).send({ error: 'EMAIL_EXISTS_GOOGLE' })
    }
    if (error instanceof InvalidCredentialsError) {
      return reply.status(401).send({ error: 'INVALID_CREDENTIALS' })
    }
    if (error instanceof InvalidEmailError) {
      return reply.status(400).send({ error: 'INVALID_EMAIL' })
    }
    if (error instanceof WeakPasswordError) {
      return reply.status(400).send({ error: 'WEAK_PASSWORD' })
    }
    if (error instanceof InvalidTokenError) {
      return reply.status(401).send({ error: 'INVALID_TOKEN' })
    }
    if (error instanceof GoogleAuthError) {
      return reply.status(401).send({ error: 'GOOGLE_AUTH_FAILED' })
    }

    throw error
  }
}
