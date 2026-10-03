import type { FastifyReply, FastifyRequest } from 'fastify'
import type { CookieSerializeOptions } from '@fastify/cookie'
import { isSafeReturnTo, buildOAuthCallbackUrl } from '../../../shared/infrastructure/http/oauthCallbackRedirect'
import { laxSameSite, secureCookie } from '../../../shared/infrastructure/http/cookieSameSitePolicy'
import type { StartOAuthUseCase } from '../../application/use-cases/StartOAuthUseCase'
import {
  HandleOAuthCallbackUseCase,
  MissingAuthorizationCodeError,
  OAuthConsentDeniedError,
  OAuthProviderError,
} from '../../application/use-cases/HandleOAuthCallbackUseCase'
import { YouTubeOAuthError } from '../providers/YouTubeOAuthProvider'
import { TikTokOAuthError } from '../providers/TikTokOAuthProvider'
import type { GetTikTokPublishingCapabilitiesUseCase } from '../../application/use-cases/GetTikTokPublishingCapabilitiesUseCase'
import { VideoPlatform } from '../../domain/entities/PublishedVideo'
import { InvalidRequestError, isVideoPlatform } from './httpValidation'
import { isRecord } from '../../../shared/domain/validation'

interface OAuthCallbackQuery {
  code?: string
  state?: string
  error?: string
}

/** Único punto de validación de forma del querystring del callback OAuth — de aquí en adelante el tipo se propaga sin recastear. */
function parseOAuthCallbackQuery(value: unknown): OAuthCallbackQuery {
  if (!isRecord(value)) {
    throw new InvalidRequestError('OAuth callback querystring must be an object')
  }
  if (
    (value.code !== undefined && typeof value.code !== 'string') ||
    (value.state !== undefined && typeof value.state !== 'string') ||
    (value.error !== undefined && typeof value.error !== 'string')
  ) {
    throw new InvalidRequestError('OAuth callback querystring has malformed code/state/error')
  }
  return { code: value.code, state: value.state, error: value.error }
}

interface OAuthStartQuery {
  json?: string
  returnTo?: string
}

/** Único punto de validación de forma del querystring de auth/start — de aquí en adelante el tipo se propaga sin recastear. */
function parseOAuthStartQuery(value: unknown): OAuthStartQuery {
  if (!isRecord(value)) {
    throw new InvalidRequestError('auth/start querystring must be an object')
  }
  if (
    (value.json !== undefined && typeof value.json !== 'string') ||
    (value.returnTo !== undefined && typeof value.returnTo !== 'string')
  ) {
    throw new InvalidRequestError('auth/start querystring has malformed json/returnTo')
  }
  return { json: value.json, returnTo: value.returnTo }
}

const OAUTH_STATE_COOKIE_PATH_BY_PLATFORM: Record<VideoPlatform, string> = {
  [VideoPlatform.YouTube]: '/api/publishing/youtube/auth',
  [VideoPlatform.TikTok]: '/api/publishing/tiktok/auth',
}

function oauthStateCookieName(platform: VideoPlatform, suffix: 'state' | 'organization_id' | 'return_to'): string {
  return `${platform}_oauth_${suffix}`
}

function stateCookieOptions(platform: VideoPlatform): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: secureCookie,
    sameSite: laxSameSite,
    path: OAUTH_STATE_COOKIE_PATH_BY_PLATFORM[platform],
    maxAge: 60 * 10,
  }
}

/** Conexión de cuentas de plataforma (OAuth) + consulta de capacidades de TikTok — separado de
 * BulkUploadController y GenerateMetadataController porque son responsabilidades HTTP sin
 * relación entre sí, que solo compartían archivo por transportar el mismo bounded context. */
export class PlatformOAuthController {
  constructor(
    private readonly startOAuthUseCaseByPlatform: Record<VideoPlatform, StartOAuthUseCase>,
    private readonly handleOAuthCallbackUseCaseByPlatform: Record<VideoPlatform, HandleOAuthCallbackUseCase>,
    private readonly getTikTokPublishingCapabilitiesUseCase: GetTikTokPublishingCapabilitiesUseCase,
    private readonly frontendUrl: string,
  ) {}

  async oauthStart(req: FastifyRequest, reply: FastifyReply) {
    const { platform } = req.params as { platform: string }
    if (!isVideoPlatform(platform)) {
      return reply.status(404).send({ error: 'UNKNOWN_PLATFORM' })
    }
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    try {
      const { json, returnTo } = parseOAuthStartQuery(req.query)

      const state = crypto.randomUUID()
      reply.setCookie(oauthStateCookieName(platform, 'state'), state, stateCookieOptions(platform))
      // El callback de cualquier proveedor OAuth es una navegación top-level del navegador (no
      // lleva el header Authorization) — por eso authMiddleware no puede aplicarse ahí.
      // organizationId se captura acá (donde sí hay Bearer token) y viaja en una cookie
      // httpOnly junto al state.
      reply.setCookie(oauthStateCookieName(platform, 'organization_id'), req.organizationId, stateCookieOptions(platform))

      if (returnTo && isSafeReturnTo(returnTo)) {
        reply.setCookie(oauthStateCookieName(platform, 'return_to'), returnTo, stateCookieOptions(platform))
      }

      const url = this.startOAuthUseCaseByPlatform[platform].execute(state)

      // El header Location de una respuesta 302 no es legible desde fetch/XHR (limitación de
      // la spec, no configurable vía CORS) — el frontend llama con json=true, lee la URL del
      // body y navega él mismo con window.location.assign(url). Mismo mecanismo para
      // cualquier plataforma (ver oauth.ts del frontend: una sola función genérica,
      // startPlatformOAuth(platform, returnTo), sin lógica especial por plataforma).
      if (json === 'true') {
        return reply.status(200).send({ url })
      }

      return reply.redirect(url)
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        req.log.error(error, `${platform} oauth/start invalid request`)
        return reply.status(400).send({ error: 'INVALID_REQUEST', message: error.message })
      }
      throw error
    }
  }

  async oauthCallback(req: FastifyRequest, reply: FastifyReply) {
    const { platform } = req.params as { platform: string }
    if (!isVideoPlatform(platform)) {
      return reply.status(404).send({ error: 'UNKNOWN_PLATFORM' })
    }

    // returnTo se lee de la cookie antes del try para que esté disponible en el catch-all
    // incluso si el parseo del querystring falla — sin esto, un query malformado perdería
    // el returnTo al redirigir con error, aunque la cookie sí lo tuviera.
    const returnTo = req.cookies[oauthStateCookieName(platform, 'return_to')]
    reply.clearCookie(oauthStateCookieName(platform, 'state'), stateCookieOptions(platform))
    reply.clearCookie(oauthStateCookieName(platform, 'organization_id'), stateCookieOptions(platform))
    reply.clearCookie(oauthStateCookieName(platform, 'return_to'), stateCookieOptions(platform))

    try {
      const { code, state, error: providerError } = parseOAuthCallbackQuery(req.query)
      const expectedState = req.cookies[oauthStateCookieName(platform, 'state')]
      const organizationId = req.cookies[oauthStateCookieName(platform, 'organization_id')]

      if (!state || state !== expectedState || !organizationId) {
        return this.redirectWithError(reply, platform, 'STATE_MISMATCH', returnTo)
      }

      await this.handleOAuthCallbackUseCaseByPlatform[platform].execute({ organizationId, code, error: providerError })
      return reply.redirect(this.buildCallbackUrl(platform, { [`${platform}Connected`]: 'true' }, returnTo))
    } catch (error) {
      if (error instanceof OAuthConsentDeniedError) {
        return this.redirectWithError(reply, platform, 'CONSENT_DENIED', returnTo)
      }
      if (error instanceof OAuthProviderError) {
        // Fallo real del proveedor (server_error, temporarily_unavailable, invalid_scope,
        // etc.), no un rechazo del usuario — se distingue del caso anterior para no mostrarle
        // "denegaste el permiso" cuando el problema es de infraestructura del proveedor.
        req.log.error(error, `${platform} OAuth callback returned an error`)
        return this.redirectWithError(reply, platform, `${platform.toUpperCase()}_OAUTH_ERROR`, returnTo)
      }
      if (error instanceof MissingAuthorizationCodeError) {
        req.log.error(error, `${platform} OAuth callback missing code with no provider error`)
        return this.redirectWithError(reply, platform, 'MISSING_AUTHORIZATION_CODE', returnTo)
      }
      if (error instanceof YouTubeOAuthError || error instanceof TikTokOAuthError) {
        req.log.error(error, `${platform} OAuth token exchange failed`)
        return this.redirectWithError(reply, platform, `${platform.toUpperCase()}_AUTH_FAILED`, returnTo)
      }
      req.log.error(error, `Unexpected error in ${platform} OAuth callback`)
      return this.redirectWithError(reply, platform, 'UNEXPECTED_ERROR', returnTo)
    }
  }

  async tiktokCapabilities(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }
    const capabilities = await this.getTikTokPublishingCapabilitiesUseCase.execute(req.organizationId)
    return reply.status(200).send(capabilities)
  }

  private buildCallbackUrl(platform: VideoPlatform, params: Record<string, string>, returnTo: string | undefined): string {
    return buildOAuthCallbackUrl(this.frontendUrl, `/publishing/${platform}/callback`, params, returnTo)
  }

  private redirectWithError(reply: FastifyReply, platform: VideoPlatform, error: string, returnTo?: string) {
    return reply.redirect(this.buildCallbackUrl(platform, { error }, returnTo))
  }
}
