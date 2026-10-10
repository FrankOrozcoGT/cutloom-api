import { eq, sql } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { platformOAuthTokens } from '../db/schema'
import { PlatformOAuthToken } from '../../domain/entities/PlatformOAuthToken'
import type {
  UpsertPlatformOAuthTokenInput,
  PlatformOAuthTokenRepository,
} from '../../domain/ports/PlatformOAuthTokenRepository'

function toEntity(row: typeof platformOAuthTokens.$inferSelect): PlatformOAuthToken {
  return PlatformOAuthToken.create({
    id: row.id,
    platformAccountId: row.platformAccountId,
    encryptedAccessToken: row.encryptedAccessToken,
    encryptedRefreshToken: row.encryptedRefreshToken,
    expiresAt: row.expiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

export class DrizzlePlatformOAuthTokenRepository implements PlatformOAuthTokenRepository {
  constructor(private readonly db: Database) {}

  async findByPlatformAccountId(platformAccountId: string): Promise<PlatformOAuthToken | null> {
    const [row] = await this.db
      .select()
      .from(platformOAuthTokens)
      .where(eq(platformOAuthTokens.platformAccountId, platformAccountId))
      .limit(1)

    return row ? toEntity(row) : null
  }

  async upsert(input: UpsertPlatformOAuthTokenInput): Promise<PlatformOAuthToken> {
    const [row] = await this.db
      .insert(platformOAuthTokens)
      .values({
        platformAccountId: input.platformAccountId,
        encryptedAccessToken: input.encryptedAccessToken,
        encryptedRefreshToken: input.encryptedRefreshToken,
        expiresAt: input.expiresAt,
        refreshExpiresAt: input.refreshExpiresAt,
      })
      .onConflictDoUpdate({
        target: [platformOAuthTokens.platformAccountId],
        set: {
          encryptedAccessToken: input.encryptedAccessToken,
          // Si la plataforma no devolvió refresh_token en esta reconexión, se conserva el
          // existente en vez de pisarlo con null — la mayoría de proveedores solo lo re-emiten
          // en el primer consent, no en reconexiones posteriores del mismo usuario.
          encryptedRefreshToken: input.encryptedRefreshToken
            ? input.encryptedRefreshToken
            : sql`${platformOAuthTokens.encryptedRefreshToken}`,
          expiresAt: input.expiresAt,
          refreshExpiresAt: input.refreshExpiresAt ?? sql`${platformOAuthTokens.refreshExpiresAt}`,
          updatedAt: new Date(),
        },
      })
      .returning()

    if (!row) throw new Error(`Failed to upsert OAuth token for platform account ${input.platformAccountId}`)
    return toEntity(row)
  }
}
