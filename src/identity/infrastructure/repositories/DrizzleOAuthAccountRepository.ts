import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { oauthAccounts } from '../db/schema'
import { OAuthAccount } from '../../domain/entities/OAuthAccount'
import type {
  CreateOAuthAccountInput,
  OAuthAccountRepository,
  UpdateOAuthAccountTokensInput,
} from '../../domain/ports/OAuthAccountRepository'
import type { OAuthProvider } from '../../domain/entities/OAuthAccount'

function toEntity(row: typeof oauthAccounts.$inferSelect): OAuthAccount {
  return OAuthAccount.create({
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    providerAccountId: row.providerAccountId,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

export class DrizzleOAuthAccountRepository implements OAuthAccountRepository {
  constructor(private readonly db: Database) {}

  async findByUserIdAndProvider(userId: string, provider: OAuthProvider): Promise<OAuthAccount | null> {
    const [row] = await this.db
      .select()
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)))
      .limit(1)
    return row ? toEntity(row) : null
  }

  async findByProviderAccountId(provider: OAuthProvider, providerAccountId: string): Promise<OAuthAccount | null> {
    const [row] = await this.db
      .select()
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.provider, provider), eq(oauthAccounts.providerAccountId, providerAccountId)))
      .limit(1)
    return row ? toEntity(row) : null
  }

  async create(input: CreateOAuthAccountInput): Promise<OAuthAccount> {
    const [row] = await this.db
      .insert(oauthAccounts)
      .values({
        userId: input.userId,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAt,
      })
      .returning()

    if (!row) {
      throw new Error('Failed to create OAuth account')
    }

    return toEntity(row)
  }

  async updateTokens(userId: string, provider: OAuthProvider, tokens: UpdateOAuthAccountTokensInput): Promise<void> {
    await this.db
      .update(oauthAccounts)
      .set({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        updatedAt: new Date(),
      })
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)))
  }
}
