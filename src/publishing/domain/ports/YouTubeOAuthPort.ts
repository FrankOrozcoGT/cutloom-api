export interface YouTubeTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  /** Solo presentes en el intercambio inicial del code (no en refresh) — ver YouTubeOAuthProvider. */
  googleEmail: string | null
  channelTitle: string | null
}

export interface YouTubeOAuthPort {
  buildAuthorizationUrl(state: string): string
  exchangeCodeForTokens(code: string): Promise<YouTubeTokens>
  refreshAccessToken(refreshToken: string): Promise<Omit<YouTubeTokens, 'refreshToken' | 'googleEmail' | 'channelTitle'>>
}
