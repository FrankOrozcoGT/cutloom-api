export interface PasswordHasher {
  hash(plaintext: string): Promise<string>
  compare(plaintext: string, hash: string): Promise<boolean>
}
