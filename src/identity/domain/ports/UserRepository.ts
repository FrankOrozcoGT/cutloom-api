import type { User, AuthType } from '../entities/User'

export class EmailAlreadyExistsError extends Error {
  constructor(email: string) {
    super(`Email already exists: ${email}`)
    this.name = 'EmailAlreadyExistsError'
  }
}

export interface CreateUserInput {
  email: string
  passwordHash: string | null
  authType: AuthType
  name: string | null
}

export interface UserRepository {
  findById(id: string): Promise<User | null>
  findByEmail(email: string): Promise<User | null>
  create(input: CreateUserInput): Promise<User>
}
