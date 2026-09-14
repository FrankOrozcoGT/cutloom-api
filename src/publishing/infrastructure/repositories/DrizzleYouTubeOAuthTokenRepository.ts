import { eq, sql } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { youtubeOAuthTokens } from '../db/schema'
import { YouTubeOAuthToken } from '../../domain/entities/YouTubeOAuthToken'
import type {
  UpsertYouTubeOAuthTokenInput,
  YouTubeOAuthTokenRepository,
} from '../../domain/ports/YouTubeOAuthTokenRepository'

function toEntity(row: typeof youtubeOAuthTokens.$inferSelect): YouTubeOAuthToken {
  return YouTubeOAuthToken.create({
    id: row.id,
    organizationId: row.organizationId,
    encryptedAccessToken: row.encryptedAccessToken,
    encryptedRefreshToken: row.encryptedRefreshToken,
    expiresAt: row.expiresAt,
    googleEmail: row.googleEmail,
    channelTitle: row.channelTitle,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

export class DrizzleYouTubeOAuthTokenRepository implements YouTubeOAuthTokenRepository {
  constructor(private readonly db: Database) {}

  async findByOrganizationId(organizationId: string): Promise<YouTubeOAuthToken | null> {
    const [row] = await this.db
      .select()
      .from(youtubeOAuthTokens)
      .where(eq(youtubeOAuthTokens.organizationId, organizationId))
      .limit(1)

    return row ? toEntity(row) : null
  }

  async upsert(input: UpsertYouTubeOAuthTokenInput): Promise<YouTubeOAuthToken> {
    const [row] = await this.db
      .insert(youtubeOAuthTokens)
      .values({
        organizationId: input.organizationId,
        encryptedAccessToken: input.encryptedAccessToken,
        encryptedRefreshToken: input.encryptedRefreshToken,
        expiresAt: input.expiresAt,
        googleEmail: input.googleEmail,
        channelTitle: input.channelTitle,
      })
      .onConflictDoUpdate({
        target: youtubeOAuthTokens.organizationId,
        set: {
          encryptedAccessToken: input.encryptedAccessToken,
          // Si Google no devolvió refresh_token en esta reconexión, se conserva el existente
          // en vez de pisarlo con null — Google solo lo re-emite en el primer consent, no en
          // reconexiones posteriores del mismo usuario.
          encryptedRefreshToken: input.encryptedRefreshToken
            ? input.encryptedRefreshToken
            : sql`${youtubeOAuthTokens.encryptedRefreshToken}`,
          expiresAt: input.expiresAt,
          // Mismo criterio: si channels.list falló en esta reconexión (ej. cuota, error
          // transitorio) no se pisa el nombre ya guardado con null.
          googleEmail: input.googleEmail ?? sql`${youtubeOAuthTokens.googleEmail}`,
          channelTitle: input.channelTitle ?? sql`${youtubeOAuthTokens.channelTitle}`,
          updatedAt: new Date(),
        },
      })
      .returning()

    if (!row) throw new Error(`Failed to upsert YouTube OAuth token for ${input.organizationId}`)
    return toEntity(row)
  }
}
