import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { organizations } from '../../../identity/infrastructure/db/schema'
import { YouTubeVideoStatus, YouTubeVideoType } from '../../domain/entities/YouTubeVideo'

// pgEnum exige un array literal de valores en tiempo de definición — se deriva de las
// constantes de dominio (Object.values) en vez de repetir los strings, para que el enum de
// DB y el tipo de dominio nunca puedan desincronizarse.
export const youtubeVideoStatusEnum = pgEnum(
  'youtube_video_status',
  Object.values(YouTubeVideoStatus) as [YouTubeVideoStatus, ...YouTubeVideoStatus[]],
)
export const youtubeVideoTypeEnum = pgEnum(
  'youtube_video_type',
  Object.values(YouTubeVideoType) as [YouTubeVideoType, ...YouTubeVideoType[]],
)

export const youtubeOAuthTokens = pgTable(
  'youtube_oauth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    encryptedAccessToken: text('encrypted_access_token').notNull(),
    // null cuando Google no devolvió refresh_token (p.ej. reconexión sin prompt=consent previo).
    encryptedRefreshToken: text('encrypted_refresh_token'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('youtube_oauth_tokens_organization_id_idx').on(table.organizationId)],
)

export const contentRevisions = pgTable(
  'content_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // Identifica el video/short al que pertenece esta cadena de revisiones — no hay FK
    // porque el source (proyecto/clip) vive en media-editing/shorts-intelligence, fuera
    // de este bounded context.
    sourceId: text('source_id').notNull(),
    // Append-only: nunca se actualiza una fila existente, cada iteración con la IA inserta
    // version = MAX(version) + 1 para ese sourceId (ver DrizzleContentRevisionRepository).
    version: integer('version').notNull(),
    prompt: text('prompt').notNull(),
    metadata: jsonb('metadata').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // La invariante real es "por organización, la secuencia de versiones de un sourceId es
    // única" — sourceId por sí solo no es único entre organizaciones (no hay FK cruzando a
    // otro bounded context), así que el unique index debe incluir organizationId para no
    // contaminar el versionado entre tenants que coincidan en el mismo sourceId.
    uniqueIndex('content_revisions_org_id_source_id_version_idx').on(
      table.organizationId,
      table.sourceId,
      table.version,
    ),
  ],
)

export const youtubeVideos = pgTable(
  'youtube_videos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // Agrupa el video largo y sus shorts derivados de una misma serie — lo usa
    // ScheduleUploadPlanService para calcular latencia/intercalado entre series.
    seriesId: text('series_id').notNull(),
    sourceId: text('source_id').notNull(),
    videoType: youtubeVideoTypeEnum('video_type').notNull(),
    metadataRevisionId: uuid('metadata_revision_id')
      .notNull()
      .references(() => contentRevisions.id, { onDelete: 'restrict' }),
    // null si el upload falló antes de recibir un id de YouTube.
    youtubeVideoId: text('youtube_video_id'),
    status: youtubeVideoStatusEnum('status').notNull(),
    // null para publicación inmediata — no vacío solo cuando se usó scheduling nativo de YouTube.
    publishAt: timestamp('publish_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('youtube_videos_organization_id_idx').on(table.organizationId),
    index('youtube_videos_series_id_idx').on(table.seriesId),
    // Invariante real: a lo sumo un registro ACTIVO (Uploading/Uploaded/Scheduled) por
    // sourceId — Failed no cuenta, porque tras un fallo el mismo sourceId puede reintentarse
    // con una fila nueva. Un unique index incondicional rompería ese reintento legítimo; el
    // índice parcial (WHERE status != 'failed') solo aplica la unicidad a las filas vivas.
    // Antes, la única defensa era el advisory lock de aplicación (withOrganizationLock), que
    // no protege contra código futuro que inserte directamente sin pasar por ahí.
    uniqueIndex('youtube_videos_active_source_id_idx')
      .on(table.organizationId, table.sourceId)
      .where(sql`${table.status} != 'failed'`),
  ],
)
