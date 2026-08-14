const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/

export class InvalidEmailError extends Error {
  constructor(value: string) {
    super(`Invalid email format: ${value}`)
    this.name = 'InvalidEmailError'
  }
}

export class Email {
  private constructor(private readonly value: string) {}

  static create(rawValue: string): Email {
    const normalized = rawValue.trim().toLowerCase()

    if (!EMAIL_REGEX.test(normalized)) {
      throw new InvalidEmailError(rawValue)
    }

    return new Email(normalized)
  }

  toString(): string {
    return this.value
  }

  equals(other: Email): boolean {
    return this.value === other.value
  }
}
