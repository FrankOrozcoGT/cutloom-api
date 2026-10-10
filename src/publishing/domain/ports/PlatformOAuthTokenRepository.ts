import type { PlatformOAuthToken } from '../entities/PlatformOAuthToken'

export interface UpsertPlatformOAuthTokenInput {
  platformAccountId: string
  encryptedAccessToken: string
  encryptedRefreshToken: string | null
  expiresAt: Date
  refreshExpiresAt: Date | null
}

export interface PlatformOAuthTokenRepository {
  findByPlatformAccountId(platformAccountId: string): Promise<PlatformOAuthToken | null>
  /** INSERT si no existe token para esta cuenta, UPDATE si ya existe (refresh o reconexión de la misma cuenta). */
  upsert(input: UpsertPlatformOAuthTokenInput): Promise<PlatformOAuthToken>
}
