import type { OAuthAccount, OAuthProvider } from '../entities/OAuthAccount'

export interface CreateOAuthAccountInput {
  userId: string
  provider: OAuthProvider
  providerAccountId: string
  accessToken: string | null
  refreshToken: string | null
  expiresAt: Date | null
}

export interface UpdateOAuthAccountTokensInput {
  accessToken: string | null
  refreshToken: string | null
  expiresAt: Date | null
}

export interface OAuthAccountRepository {
  findByUserIdAndProvider(userId: string, provider: OAuthProvider): Promise<OAuthAccount | null>
  findByProviderAccountId(provider: OAuthProvider, providerAccountId: string): Promise<OAuthAccount | null>
  create(input: CreateOAuthAccountInput): Promise<OAuthAccount>
  updateTokens(userId: string, provider: OAuthProvider, tokens: UpdateOAuthAccountTokensInput): Promise<void>
}
