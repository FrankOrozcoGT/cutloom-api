import type { YouTubeOAuthToken } from '../entities/YouTubeOAuthToken'

export interface UpsertYouTubeOAuthTokenInput {
  organizationId: string
  encryptedAccessToken: string
  encryptedRefreshToken: string | null
  expiresAt: Date
  googleEmail: string | null
  channelTitle: string | null
}

export interface YouTubeOAuthTokenRepository {
  findByOrganizationId(organizationId: string): Promise<YouTubeOAuthToken | null>
  /** INSERT si no existe registro para la organización, UPDATE si ya existe (reconexión). */
  upsert(input: UpsertYouTubeOAuthTokenInput): Promise<YouTubeOAuthToken>
}
