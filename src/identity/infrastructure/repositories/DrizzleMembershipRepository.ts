import { eq } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { memberships } from '../db/schema'
import { Membership } from '../../domain/entities/Membership'
import type { CreateMembershipInput, MembershipRepository } from '../../domain/ports/MembershipRepository'

function toEntity(row: typeof memberships.$inferSelect): Membership {
  return Membership.create({
    id: row.id,
    userId: row.userId,
    organizationId: row.organizationId,
    role: row.role,
    createdAt: row.createdAt,
  })
}

export class DrizzleMembershipRepository implements MembershipRepository {
  constructor(private readonly db: Database) {}

  async findByUserId(userId: string): Promise<Membership[]> {
    const rows = await this.db.select().from(memberships).where(eq(memberships.userId, userId))
    return rows.map(toEntity)
  }

  async create(input: CreateMembershipInput): Promise<Membership> {
    const [row] = await this.db
      .insert(memberships)
      .values({
        userId: input.userId,
        organizationId: input.organizationId,
        role: input.role,
      })
      .returning()

    if (!row) {
      throw new Error('Failed to create membership')
    }

    return toEntity(row)
  }
}
