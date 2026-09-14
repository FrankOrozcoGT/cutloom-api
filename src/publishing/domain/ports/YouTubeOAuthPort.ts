export interface YouTubeTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
}

export interface YouTubeOAuthPort {
  buildAuthorizationUrl(state: string): string
  exchangeCodeForTokens(code: string): Promise<YouTubeTokens>
  refreshAccessToken(refreshToken: string): Promise<Omit<YouTubeTokens, 'refreshToken'>>
}
