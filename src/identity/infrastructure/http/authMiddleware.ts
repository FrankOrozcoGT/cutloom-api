import type { FastifyReply, FastifyRequest } from 'fastify'
import type { TokenService } from '../../domain/ports/TokenService'
import type { TokenBlacklistRepository } from '../../domain/ports/TokenBlacklistRepository'
import type { UserRepository } from '../../domain/ports/UserRepository'
import type { User } from '../../domain/entities/User'

declare module 'fastify' {
  interface FastifyRequest {
    user?: User
  }
}

function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null
  }
  return authorizationHeader.slice('Bearer '.length).trim()
}

export function createAuthMiddleware(
  tokenService: TokenService,
  tokenBlacklistRepository: TokenBlacklistRepository,
  userRepository: UserRepository,
) {
  return async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
    const token = extractBearerToken(req.headers.authorization)

    if (!token) {
      return reply.status(401).send({ error: 'MISSING_ACCESS_TOKEN' })
    }

    let payload
    try {
      payload = await tokenService.verifyAccessToken(token)
    } catch {
      return reply.status(401).send({ error: 'INVALID_TOKEN' })
    }

    const isBlacklisted = await tokenBlacklistRepository.isBlacklisted(token)
    if (isBlacklisted) {
      return reply.status(401).send({ error: 'INVALID_TOKEN' })
    }

    const user = await userRepository.findById(payload.userId)
    if (!user) {
      return reply.status(401).send({ error: 'INVALID_TOKEN' })
    }

    req.user = user
  }
}
