const MIN_LENGTH = 8
const HAS_UPPERCASE = /[A-Z]/
const HAS_LOWERCASE = /[a-z]/
const HAS_NUMBER = /[0-9]/

export class WeakPasswordError extends Error {
  constructor() {
    super('Password must be at least 8 characters and include an uppercase letter, a lowercase letter, and a number')
    this.name = 'WeakPasswordError'
  }
}

/**
 * Wraps a plaintext password only long enough to validate strength before hashing.
 * It never stores or represents a hash — BcryptPasswordHasher takes over from here.
 */
export class Password {
  private constructor(private readonly plainValue: string) {}

  static create(rawValue: string): Password {
    if (
      rawValue.length < MIN_LENGTH ||
      !HAS_UPPERCASE.test(rawValue) ||
      !HAS_LOWERCASE.test(rawValue) ||
      !HAS_NUMBER.test(rawValue)
    ) {
      throw new WeakPasswordError()
    }

    return new Password(rawValue)
  }

  get plaintext(): string {
    return this.plainValue
  }
}
