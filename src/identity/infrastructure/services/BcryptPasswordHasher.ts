import bcrypt from 'bcrypt'
import type { PasswordHasher } from '../../domain/ports/PasswordHasher'

const SALT_ROUNDS = 12

export class BcryptPasswordHasher implements PasswordHasher {
  async hash(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, SALT_ROUNDS)
  }

  async compare(plaintext: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plaintext, hash)
  }
}
