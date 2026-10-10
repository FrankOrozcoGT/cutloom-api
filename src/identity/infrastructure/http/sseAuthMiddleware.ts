import type { FastifyReply, FastifyRequest } from 'fastify'
import type { TokenService } from '../../domain/ports/TokenService'
import type { UserRepository } from '../../domain/ports/UserRepository'
import { strictSameSite, secureCookie } from '../../../shared/infrastructure/http/cookieSameSitePolicy'

export const SSE_TOKEN_COOKIE = 'sseAccessToken'
export const SSE_TOKEN_COOKIE_PATH = '/api/notifications'

export function sseTokenCookieOptions() {
  return {
    httpOnly: true,
    secure: secureCookie,
    sameSite: strictSameSite,
    path: SSE_TOKEN_COOKIE_PATH,
  }
}

/**
 * Autenticación para endpoints SSE (EventSource) — el navegador no permite mandar headers
 * custom en una conexión EventSource, así que authMiddleware (Bearer header) no aplica acá.
 * Un token en la query string quedaría expuesto en logs de acceso del servidor e historial del
 * navegador, así que se descarta — el patrón recomendado es cookie httpOnly, que EventSource
 * sí manda automáticamente sin intervención de JS (ver server-sent-events.com/security).
 *
 * Cookie propia (no la de refreshToken): mismo access token JWT de corta duración que ya se
 * emite en login/refresh (ver AuthController), pero puesto también en una cookie httpOnly
 * acotada a path=/api/notifications — así el token de sesión de mayor privilegio (refresh
 * token) nunca viaja fuera de /api/auth/refresh, y esta cookie de menor privilegio expira en
 * minutos como cualquier access token, reduciendo el blast radius si se filtrara.
 */
export function createSseAuthMiddleware(tokenService: TokenService, userRepository: UserRepository) {
  return async function sseAuthMiddleware(req: FastifyRequest, reply: FastifyReply) {
    const accessToken = req.cookies[SSE_TOKEN_COOKIE]
    if (!accessToken) {
      return reply.status(401).send({ error: 'MISSING_ACCESS_TOKEN' })
    }

    let payload
    try {
      payload = await tokenService.verifyAccessToken(accessToken)
    } catch {
      return reply.status(401).send({ error: 'INVALID_TOKEN' })
    }

    // Mismo criterio que authMiddleware (Bearer): los access tokens no se blacklistean
    // individualmente, solo los refresh tokens (ver LogoutUseCase) — un access token sigue
    // válido hasta su propia expiración corta (15m) aunque el usuario haya cerrado sesión.
    const user = await userRepository.findById(payload.userId)
    if (!user) {
      return reply.status(401).send({ error: 'INVALID_TOKEN' })
    }

    req.user = user
    req.organizationId = payload.organizationId
  }
}
