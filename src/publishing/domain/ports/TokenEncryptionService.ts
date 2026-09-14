export interface TokenEncryptionService {
  encrypt(plaintext: string): string
  decrypt(ciphertext: string): string
}
