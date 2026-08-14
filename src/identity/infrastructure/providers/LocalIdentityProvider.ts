import { Email } from '../../domain/value-objects/Email'
import { Password } from '../../domain/value-objects/Password'
import { EmailExistsWithGoogleError, InvalidCredentialsError } from '../../domain/ports/IdentityProvider'
import type { IdentityProvider, LocalCredentials, NormalizedIdentity } from '../../domain/ports/IdentityProvider'
import type { UserRepository } from '../../domain/ports/UserRepository'
import type { PasswordHasher } from '../../domain/ports/PasswordHasher'

/**
 * Validates local (email/password) credentials for both registration and login.
 * On registration (no existing user), only validates format/strength and hashes
 * the password — provisioning happens in AuthDomainService. On login, it verifies
 * the password against the stored hash and returns the existing user's id.
 */
export class LocalIdentityProvider implements IdentityProvider {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly passwordHasher: PasswordHasher,
  ) {}

  async validate(credentials: LocalCredentials): Promise<NormalizedIdentity> {
    const email = Email.create(credentials.email)
    const existingUser = await this.userRepository.findByEmail(email.toString())

    if (!existingUser) {
      const password = Password.create(credentials.password)
      const passwordHash = await this.passwordHasher.hash(password.plaintext)

      return { email: email.toString(), name: null, passwordHash }
    }

    if (existingUser.authType !== 'local' || !existingUser.passwordHash) {
      throw new EmailExistsWithGoogleError()
    }

    const isValid = await this.passwordHasher.compare(credentials.password, existingUser.passwordHash)

    if (!isValid) {
      throw new InvalidCredentialsError()
    }

    return { email: email.toString(), name: existingUser.name, existingUserId: existingUser.id }
  }
}
