import { eq } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { users } from '../db/schema'
import { User } from '../../domain/entities/User'
import { EmailAlreadyExistsError } from '../../domain/ports/UserRepository'
import type { CreateUserInput, UserRepository } from '../../domain/ports/UserRepository'

const POSTGRES_UNIQUE_VIOLATION = '23505'

function toEntity(row: typeof users.$inferSelect): User {
  return User.create({
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    authType: row.authType,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1)
    return row ? toEntity(row) : null
  }

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email)).limit(1)
    return row ? toEntity(row) : null
  }

  async create(input: CreateUserInput): Promise<User> {
    try {
      const [row] = await this.db
        .insert(users)
        .values({
          email: input.email,
          passwordHash: input.passwordHash,
          authType: input.authType,
          name: input.name,
        })
        .returning()

      if (!row) {
        throw new Error('Failed to create user')
      }

      return toEntity(row)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code: string }).code === POSTGRES_UNIQUE_VIOLATION
      ) {
        throw new EmailAlreadyExistsError(input.email)
      }
      throw error
    }
  }
}
