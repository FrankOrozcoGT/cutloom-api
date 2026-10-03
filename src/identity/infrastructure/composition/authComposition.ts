import type { Database } from '../../../shared/infrastructure/db/client'
import { readEnv } from '../../../shared/infrastructure/config/readEnv'
import { DrizzleUserRepository } from '../repositories/DrizzleUserRepository'
import { DrizzleOrganizationRepository } from '../repositories/DrizzleOrganizationRepository'
import { DrizzleMembershipRepository } from '../repositories/DrizzleMembershipRepository'
import { DrizzleOAuthAccountRepository } from '../repositories/DrizzleOAuthAccountRepository'
import { DrizzleTokenBlacklistRepository } from '../repositories/DrizzleTokenBlacklistRepository'
import { BcryptPasswordHasher } from '../services/BcryptPasswordHasher'
import { JwtTokenService } from '../services/JwtTokenService'
import { LocalIdentityProvider } from '../providers/LocalIdentityProvider'
import { GoogleIdentityProvider } from '../providers/GoogleIdentityProvider'
import { AuthDomainService } from '../../application/services/AuthDomainService'
import { AuthenticateUserUseCase, type AuthProviderName } from '../../application/use-cases/AuthenticateUserUseCase'
import { LogoutUseCase } from '../../application/use-cases/LogoutUseCase'
import { RefreshTokenUseCase } from '../../application/use-cases/RefreshTokenUseCase'
import { AuthController } from '../http/AuthController'
import { createAuthMiddleware } from '../http/authMiddleware'
import { createSseAuthMiddleware } from '../http/sseAuthMiddleware'
import type { IdentityProvider } from '../../domain/ports/IdentityProvider'
import type { EntitlementsReader } from '../../domain/ports/EntitlementsReader'
import type { PlatformConnectionReader } from '../../domain/ports/PlatformConnectionReader'
import type { CreditBalanceReader } from '../../domain/ports/CreditBalanceReader'

export interface AuthModule {
  controller: AuthController
  authMiddleware: ReturnType<typeof createAuthMiddleware>
  sseAuthMiddleware: ReturnType<typeof createSseAuthMiddleware>
}

export function buildAuthModule(
  db: Database,
  entitlementsReader: EntitlementsReader,
  youTubeConnectionReader: PlatformConnectionReader,
  tikTokConnectionReader: PlatformConnectionReader,
  creditBalanceReader: CreditBalanceReader,
  apiBaseUrl: string,
): AuthModule {
  const userRepository = new DrizzleUserRepository(db)
  const organizationRepository = new DrizzleOrganizationRepository(db)
  const membershipRepository = new DrizzleMembershipRepository(db)
  const oauthAccountRepository = new DrizzleOAuthAccountRepository(db)
  const tokenBlacklistRepository = new DrizzleTokenBlacklistRepository(db)

  const passwordHasher = new BcryptPasswordHasher()
  const tokenService = new JwtTokenService({
    secret: readEnv('JWT_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-only-secret-change-me-32-chars'),
    accessTokenExpiresIn: readEnv('JWT_ACCESS_EXPIRES_IN', '15m'),
    refreshTokenExpiresIn: readEnv('JWT_REFRESH_EXPIRES_IN', '30d'),
  })

  const authDomainService = new AuthDomainService(organizationRepository, userRepository, membershipRepository)

  const googleProvider = new GoogleIdentityProvider({
    clientId: readEnv('GOOGLE_CLIENT_ID', process.env.NODE_ENV === 'production' ? undefined : 'dev-placeholder'),
    clientSecret: readEnv('GOOGLE_CLIENT_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-placeholder'),
    // Construido desde API_BASE_URL (único dominio base del backend) en vez de una variable
    // suelta por proveedor — evita que cambiar de ambiente (dev/túnel/prod) requiera actualizar
    // 3 redirect_uri por separado y queden desincronizados entre sí (ver GOOGLE_REDIRECT_URI/
    // YOUTUBE_OAUTH_REDIRECT_URI/TIKTOK_OAUTH_REDIRECT_URI, eliminadas del .env).
    redirectUri: `${apiBaseUrl}/api/auth/google/callback`,
  })

  const providers: Record<AuthProviderName, IdentityProvider> = {
    local: new LocalIdentityProvider(userRepository, passwordHasher),
    google: googleProvider,
  }

  const authenticateUserUseCase = new AuthenticateUserUseCase(
    providers,
    userRepository,
    membershipRepository,
    oauthAccountRepository,
    authDomainService,
    tokenService,
  )
  const logoutUseCase = new LogoutUseCase(tokenService, tokenBlacklistRepository)
  const refreshTokenUseCase = new RefreshTokenUseCase(tokenService, tokenBlacklistRepository, userRepository)

  const controller = new AuthController(
    authenticateUserUseCase,
    logoutUseCase,
    refreshTokenUseCase,
    googleProvider,
    readEnv('FRONTEND_URL', 'http://localhost:5173'),
    entitlementsReader,
    youTubeConnectionReader,
    tikTokConnectionReader,
    creditBalanceReader,
  )
  const authMiddleware = createAuthMiddleware(tokenService, tokenBlacklistRepository, userRepository)
  const sseAuthMiddleware = createSseAuthMiddleware(tokenService, userRepository)

  return { controller, authMiddleware, sseAuthMiddleware }
}
