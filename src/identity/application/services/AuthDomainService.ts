import type { Organization } from '../../domain/entities/Organization'
import type { User, AuthType } from '../../domain/entities/User'
import type { Membership } from '../../domain/entities/Membership'
import type { OrganizationRepository } from '../../domain/ports/OrganizationRepository'
import type { UserRepository } from '../../domain/ports/UserRepository'
import type { MembershipRepository } from '../../domain/ports/MembershipRepository'

export interface CreateUserWithMembershipInput {
  email: string
  passwordHash: string | null
  authType: AuthType
  name: string | null
}

export interface ProvisionedUser {
  organization: Organization
  user: User
  membership: Membership
}

/**
 * Centralizes org+user+membership provisioning shared by local registration
 * and Google sign-up, so both flows create identical tenant structure.
 */
export class AuthDomainService {
  constructor(
    private readonly organizationRepository: OrganizationRepository,
    private readonly userRepository: UserRepository,
    private readonly membershipRepository: MembershipRepository,
  ) {}

  async createUserWithMembership(input: CreateUserWithMembershipInput): Promise<ProvisionedUser> {
    const organization = await this.organizationRepository.create({ name: `${input.email}'s org` })

    const user = await this.userRepository.create({
      email: input.email,
      passwordHash: input.passwordHash,
      authType: input.authType,
      name: input.name,
    })

    const membership = await this.membershipRepository.create({
      userId: user.id,
      organizationId: organization.id,
      role: 'owner',
    })

    return { organization, user, membership }
  }
}
