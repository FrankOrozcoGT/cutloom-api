import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { TokenEncryptionService } from '../../domain/ports/TokenEncryptionService'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const KEY_LENGTH = 32

/** Formato almacenado: iv:authTag:ciphertext, todo en hex, para poder desencriptar sin campos adicionales en DB. */
export class AesTokenEncryptionService implements TokenEncryptionService {
  private readonly key: Buffer

  constructor(encryptionKey: string) {
    const key = Buffer.from(encryptionKey, 'utf8')
    if (key.length !== KEY_LENGTH) {
      throw new Error(`YOUTUBE_ENCRYPTION_KEY must be exactly ${KEY_LENGTH} bytes, got ${key.length}`)
    }
    this.key = key
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, this.key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
  }

  decrypt(ciphertext: string): string {
    const [ivHex, authTagHex, dataHex] = ciphertext.split(':')
    if (!ivHex || !authTagHex || !dataHex) {
      throw new Error('Malformed encrypted token payload')
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
    return decrypted.toString('utf8')
  }
}
