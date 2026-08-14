import type { User } from '../../domain/entities/User'
import { InvalidCredentialsError } from '../../domain/ports/IdentityProvider'
import type { IdentityProvider, IdentityCredentials } from '../../domain/ports/IdentityProvider'
import { EmailAlreadyExistsError } from '../../domain/ports/UserRepository'
import type { UserRepository } from '../../domain/ports/UserRepository'
import { selectActiveMembership } from '../../domain/ports/MembershipRepository'
import type { MembershipRepository } from '../../domain/ports/MembershipRepository'
import type { OAuthAccountRepository } from '../../domain/ports/OAuthAccountRepository'
import type { TokenService, TokenPair } from '../../domain/ports/TokenService'
import { AuthDomainService } from '../services/AuthDomainService'

export type AuthProviderName = 'local' | 'google'
export type AuthIntent = 'register' | 'login'

export interface AuthenticateUserInput {
  provider: AuthProviderName
  /** Only meaningful for provider: 'local' — Google always registers-or-logs-in implicitly. */
  intent?: AuthIntent
  credentials: IdentityCredentials
}

export interface AuthenticateUserResult {
  user: User
  tokens: TokenPair
  isNewUser: boolean
}

export class EmailExistsLocalError extends Error {
  constructor() {
    super('This email is already registered with a password. Please sign in with email and password.')
    this.name = 'EmailExistsLocalError'
  }
}

export class AuthenticateUserUseCase {
  constructor(
    private readonly providers: Record<AuthProviderName, IdentityProvider>,
    private readonly userRepository: UserRepository,
    private readonly membershipRepository: MembershipRepository,
    private readonly oauthAccountRepository: OAuthAccountRepository,
    private readonly authDomainService: AuthDomainService,
    private readonly tokenService: TokenService,
  ) {}

  async execute(input: AuthenticateUserInput): Promise<AuthenticateUserResult> {
    const provider = this.providers[input.provider]
    const identity = await provider.validate(input.credentials)

    let user: User
    let isNewUser = false
    let organizationId: string

    if (identity.existingUserId) {
      if (input.intent === 'register') {
        throw new EmailAlreadyExistsError(identity.email)
      }

      const existingUser = await this.userRepository.findById(identity.existingUserId)
      if (!existingUser) {
        throw new Error(`User not found: ${identity.existingUserId}`)
      }
      user = existingUser
      organizationId = selectActiveMembership(await this.membershipRepository.findByUserId(user.id)).organizationId
    } else {
      const existingUser = await this.userRepository.findByEmail(identity.email)

      if (existingUser) {
        if (identity.oauth && existingUser.authType === 'local') {
          throw new EmailExistsLocalError()
        }

        user = existingUser
        organizationId = selectActiveMembership(await this.membershipRepository.findByUserId(user.id)).organizationId

        if (identity.oauth) {
          await this.oauthAccountRepository.updateTokens(user.id, identity.oauth.provider, {
            accessToken: identity.oauth.accessToken,
            refreshToken: identity.oauth.refreshToken,
            expiresAt: identity.oauth.expiresAt,
          })
        }
      } else {
        if (input.provider === 'local' && input.intent === 'login') {
          throw new InvalidCredentialsError()
        }

        const provisioned = await this.authDomainService.createUserWithMembership({
          email: identity.email,
          passwordHash: identity.passwordHash ?? null,
          authType: identity.oauth ? 'google' : 'local',
          name: identity.name,
        })
        user = provisioned.user
        organizationId = provisioned.membership.organizationId
        isNewUser = true

        if (identity.oauth) {
          await this.oauthAccountRepository.create({
            userId: user.id,
            provider: identity.oauth.provider,
            providerAccountId: identity.oauth.providerAccountId,
            accessToken: identity.oauth.accessToken,
            refreshToken: identity.oauth.refreshToken,
            expiresAt: identity.oauth.expiresAt,
          })
        }
      }
    }

    const tokens = await this.tokenService.generateTokenPair({
      userId: user.id,
      organizationId,
    })

    return { user, tokens, isNewUser }
  }
}
