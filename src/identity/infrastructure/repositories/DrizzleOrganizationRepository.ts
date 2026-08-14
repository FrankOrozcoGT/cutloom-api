import { eq } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { organizations } from '../db/schema'
import { Organization } from '../../domain/entities/Organization'
import type { CreateOrganizationInput, OrganizationRepository } from '../../domain/ports/OrganizationRepository'

function toEntity(row: typeof organizations.$inferSelect): Organization {
  return Organization.create({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

export class DrizzleOrganizationRepository implements OrganizationRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<Organization | null> {
    const [row] = await this.db.select().from(organizations).where(eq(organizations.id, id)).limit(1)
    return row ? toEntity(row) : null
  }

  async create(input: CreateOrganizationInput): Promise<Organization> {
    const [row] = await this.db.insert(organizations).values({ name: input.name }).returning()

    if (!row) {
      throw new Error('Failed to create organization')
    }

    return toEntity(row)
  }
}
