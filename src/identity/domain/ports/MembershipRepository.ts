import type { Membership, MembershipRole } from '../entities/Membership'

export interface CreateMembershipInput {
  userId: string
  organizationId: string
  role: MembershipRole
}

export interface MembershipRepository {
  findByUserId(userId: string): Promise<Membership[]>
  create(input: CreateMembershipInput): Promise<Membership>
}

/**
 * Picks which membership backs the JWT's organizationId. Today every user has
 * exactly one, so this is a no-op; the day a user can belong to multiple
 * organizations, this single function is where that decision gets made
 * (e.g. prefer 'owner', or require explicit org selection) instead of it
 * being scattered across call sites.
 */
export function selectActiveMembership(memberships: Membership[]): Membership {
  const [first] = memberships
  if (!first) {
    throw new Error('User has no memberships')
  }
  return first
}
