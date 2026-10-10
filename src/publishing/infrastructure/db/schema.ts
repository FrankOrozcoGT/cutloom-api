import { sql } from 'drizzle-orm'
import { bigint, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { organizations } from '../../../identity/infrastructure/db/schema'
import type { PublishedVideoStatus, PublishedVideoType, VideoPlatform } from '../../domain/entities/PublishedVideo'
import type { BulkUploadStatus } from '../../domain/entities/BulkUpload'
import type { SourceUploadStatus } from '../../domain/entities/SourceUpload'

// text puro en vez de pgEnum a propósito: agregar/quitar un valor de estos sets es un cambio
// de código (el `as const` de dominio), nunca una migración de `ALTER TYPE ... ADD VALUE`. El
// `$type` solo aporta el tipo en TypeScript — la validación real de que el valor pertenece al
// set vigente ocurre en el dominio, no en una constraint de Postgres.

/**
 * Una cuenta de plataforma conectada alguna vez por una organización — persiste aunque la
 * organización cambie a otra cuenta, para no perder el historial de qué cuenta publicó cada
 * published_videos existente. `externalAccountId` es el id real y estable que la propia
 * plataforma devuelve (YouTube: channelId; TikTok: openId), nunca inventado — es la clave real
 * de unicidad: reconectar la misma cuenta más de una vez siempre resuelve a la misma fila.
 */
export const platformAccounts = pgTable(
  'platform_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().$type<VideoPlatform>(),
    externalAccountId: text('external_account_id').notNull(),
    // Solo informativo (mostrar "conectado como X" en el frontend) — shape distinto por
    // plataforma, opaco para el esquema — ver PlatformAccount.platformAccountInfo.
    platformAccountInfo: jsonb('platform_account_info'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('platform_accounts_org_platform_external_id_idx').on(
      table.organizationId,
      table.platform,
      table.externalAccountId,
    ),
  ],
)

/**
 * Cuál PlatformAccount usa ahora cada organización, por plataforma — distinto de
 * platform_accounts (historial de toda cuenta conectada alguna vez): esta tabla SÍ se
 * sobreescribe cada vez que la organización reconecta con una cuenta distinta. Una organización
 * puede tener una fila para YouTube y otra independiente para TikTok al mismo tiempo.
 */
export const activePlatformAccounts = pgTable(
  'active_platform_accounts',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().$type<VideoPlatform>(),
    platformAccountId: uuid('platform_account_id')
      .notNull()
      .references(() => platformAccounts.id, { onDelete: 'cascade' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('active_platform_accounts_org_platform_idx').on(table.organizationId, table.platform),
  ],
)

/**
 * Tabla única de tokens OAuth, compartida por cualquier plataforma — un token por
 * PlatformAccount (no por organización+plataforma: dos cuentas distintas de la misma
 * organización tienen cada una su propio token, incluso si solo una está activa ahora).
 */
export const platformOAuthTokens = pgTable(
  'platform_oauth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platformAccountId: uuid('platform_account_id')
      .notNull()
      .references(() => platformAccounts.id, { onDelete: 'cascade' }),
    encryptedAccessToken: text('encrypted_access_token').notNull(),
    // null cuando la plataforma no devolvió refresh_token (p.ej. reconexión sin prompt=consent previo).
    encryptedRefreshToken: text('encrypted_refresh_token'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Solo algunas plataformas (TikTok) emiten un refresh_token con vencimiento propio — null en las que no.
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('platform_oauth_tokens_platform_account_id_idx').on(table.platformAccountId)],
)

/**
 * Un bulk de publicación: la unidad que el usuario arma de una vez (video largo + shorts
 * derivados, hacia una o varias plataformas a la vez) — agrupa todos los SourceUpload y
 * PublishedVideo de un mismo seriesId para poder expirarlo/cancelarlo como un todo. No existe
 * sin que el usuario haya llamado a planBulkUpload: se crea en ese mismo momento, antes de que
 * llegue ningún byte de ningún archivo.
 */
export const bulkUploads = pgTable(
  'bulk_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    seriesId: text('series_id').notNull(),
    // Persistidos acá (no en memoria del proceso) porque la calendarización real recién se
    // calcula cuando TODOS los SourceUpload del bulk terminan — eso puede pasar minutos, horas
    // o días después de planBulkUpload, incluso tras un reinicio/redeploy del backend; un Map
    // en memoria perdería esta info y además no funcionaría con más de una instancia corriendo.
    timeZone: text('time_zone').notNull(),
    longVideoPublishDay: timestamp('long_video_publish_day', { withTimezone: true }).notNull(),
    status: text('status').notNull().$type<BulkUploadStatus>(),
    // Se actualiza con cualquier actividad (PATCH de tus) en CUALQUIER archivo de este bulk —
    // el conteo de expiración es del bulk completo, no por archivo individual (ver
    // ExpireStaleBulkUploadsUseCase). Reinicia el plazo de 7 días entero si el usuario retoma
    // cualquier archivo, aunque los demás lleven días sin actividad.
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('bulk_uploads_organization_id_idx').on(table.organizationId),
    // Cola que el cron de expiración recorre a diario — solo bulks todavía activos importan.
    index('bulk_uploads_status_last_activity_idx').on(table.status, table.lastActivityAt),
    // Un seriesId es, por diseño de producto, un solo bulk a la vez: reintentar un seriesId
    // expirado/cancelado crea un bulk nuevo (status distinto), nunca convive un segundo bulk
    // "active" con el mismo seriesId.
    uniqueIndex('bulk_uploads_active_series_id_idx')
      .on(table.seriesId)
      .where(sql`${table.status} = 'active'`),
  ],
)

/**
 * El binario físico de un sourceId dentro de un bulk — UNO solo por sourceId, compartido entre
 * todas las plataformas a las que ese item se publique (ver published_videos, que tiene una
 * fila por plataforma pero todas apuntan al mismo SourceUpload). tusUploadId es el id que
 * @tus/server:S3Store usa como key en R2 — se resuelve a un stream de lectura ahí mismo
 * (S3Store.read) cuando toca publicar a YouTube, o se usa directo como objeto R2 para TikTok.
 */
export const sourceUploads = pgTable(
  'source_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bulkUploadId: uuid('bulk_upload_id')
      .notNull()
      .references(() => bulkUploads.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    tusUploadId: text('tus_upload_id').notNull(),
    status: text('status').notNull().$type<SourceUploadStatus>(),
    videoSizeBytes: bigint('video_size_bytes', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('source_uploads_bulk_upload_id_idx').on(table.bulkUploadId),
    // Un sourceId tiene un único SourceUpload (el binario es compartido entre plataformas) —
    // ver también published_videos_active_source_id_idx, que es la unicidad POR PLATAFORMA.
    uniqueIndex('source_uploads_bulk_upload_id_source_id_idx').on(table.bulkUploadId, table.sourceId),
    // Búsqueda inversa desde el hook onUploadFinish de tus (solo conoce el tusUploadId).
    uniqueIndex('source_uploads_tus_upload_id_idx').on(table.tusUploadId),
  ],
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
    // de este bounded context. Compartida entre plataformas: el mismo ContentRevision (título,
    // descripción, tags) se adapta al shape de cada plataforma en el momento de publicar (ver
    // adaptMetadataForTikTok) — nunca se genera contenido separado por plataforma.
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

/**
 * Tabla única de tracking de publicación, compartida por cualquier plataforma (YouTube,
 * TikTok, la que venga después) — la columna `platform` es el único discriminante; el resto
 * del modelo (estado, calendarización, unicidad por sourceId activo) es idéntico sin importar
 * el destino. `platformOptions` guarda los campos específicos de una plataforma que no aplican
 * a las demás (ej. privacyLevel/postMode de TikTok) sin ensuciar el esquema común con columnas
 * nullable por-plataforma.
 */
export const publishedVideos = pgTable(
  'published_videos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().$type<VideoPlatform>(),
    // Cuenta de plataforma real que publicó (o va a publicar) este video — nunca "la cuenta
    // activa ahora": si la organización reconecta con otra cuenta después de agendar este
    // registro, debe seguir resolviéndose y publicándose con la cuenta original. restrict (no
    // cascade): una cuenta con videos publicados no debe poder borrarse sin antes resolver qué
    // pasa con su historial.
    platformAccountId: uuid('platform_account_id')
      .notNull()
      .references(() => platformAccounts.id, { onDelete: 'restrict' }),
    // El binario real — compartido con cualquier otra fila de published_videos que publique
    // este mismo sourceId a otra plataforma (ver SourceUpload). restrict: no tiene sentido
    // borrar un SourceUpload mientras algún published_videos todavía lo referencia.
    sourceUploadId: uuid('source_upload_id')
      .notNull()
      .references(() => sourceUploads.id, { onDelete: 'restrict' }),
    // Agrupa el video largo y sus shorts derivados de una misma serie — lo usa
    // ScheduleUploadPlanService para calcular latencia/intercalado entre series.
    seriesId: text('series_id').notNull(),
    sourceId: text('source_id').notNull(),
    videoType: text('video_type').notNull().$type<PublishedVideoType>(),
    // Prioridad relativa (0-1, ignorada para el largo) que decide el orden dentro de la fase
    // fuerte/débil al calendarizar (ver ScheduleUploadPlanService) — persistida acá porque la
    // calendarización real se calcula recién cuando TODO el bulk terminó de subir, no en el
    // momento de planBulkUpload; sin esto, el orden pedido por el caller (ej. score de
    // shorts-intelligence) se perdería entre ambos momentos.
    priority: doublePrecision('priority'),
    // Solo para shorts: segundo exacto donde arranca este short dentro de su video largo — el
    // frontend lo manda para construir el link "2 minutos antes" en la descripción (ver
    // appendLongVideoLink). Persistido acá por la misma razón que priority: la publicación real
    // ocurre después de planBulkUpload, no en el mismo momento.
    longVideoTimestampSec: integer('long_video_timestamp_sec'),
    // Solo para shorts, opcional: URL del video largo ya publicado cuando ese largo NO viene en
    // este mismo bulk (ej. se subió en un bulk anterior, o esta plataforma nunca lo recibe — ver
    // excludesLongVideos). Si es null, BulkUploadOrchestrator intenta resolverlo buscando el
    // largo de la misma seriesId ya publicado en la misma plataforma.
    longVideoUrl: text('long_video_url'),
    metadataRevisionId: uuid('metadata_revision_id')
      .notNull()
      .references(() => contentRevisions.id, { onDelete: 'restrict' }),
    // Id del video ya publicado en la plataforma — null si el upload falló antes de recibir
    // confirmación (youtube videoId / TikTok publicaly_available_post_id).
    platformVideoId: text('platform_video_id'),
    // Solo TikTok: id devuelto por video/init, necesario para el polling de status/fetch.
    // Siempre null en YouTube.
    publishId: text('publish_id'),
    status: text('status').notNull().$type<PublishedVideoStatus>(),
    // null para publicación inmediata — no vacío mientras el registro está Scheduled. En
    // YouTube resuelve scheduling nativo (se manda a la API); en TikTok resuelve scheduling
    // server-side (la Content Posting API no lo soporta nativo — ver docs/tiktok-publishing-viability.md).
    publishAt: timestamp('publish_at', { withTimezone: true }),
    // Opciones específicas de la plataforma que no tienen equivalente universal (ej. TikTok
    // privacyLevel/postMode) — jsonb en vez de columnas nullable por-plataforma, para que
    // agregar una plataforma nueva no requiera una migración de columnas.
    platformOptions: jsonb('platform_options'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('published_videos_organization_id_idx').on(table.organizationId),
    index('published_videos_series_id_idx').on(table.seriesId),
    // Búsqueda del webhook de TikTok (resuelve por publishId sin conocer organizationId de antemano — ver HandlePlatformWebhookUseCase).
    index('published_videos_publish_id_idx').on(table.publishId),
    // Cola de vencidos que el cron de publicación programada (TikTok) recorre cada hora.
    index('published_videos_due_scheduled_idx').on(table.platform, table.status, table.publishAt),
    index('published_videos_platform_account_id_idx').on(table.platformAccountId),
    // Resuelve "a qué plataformas publicar" cuando un SourceUpload llega a Completed (ver
    // BulkUploadOrchestrator.onSourceUploadCompleted).
    index('published_videos_source_upload_id_idx').on(table.sourceUploadId),
    // Invariante real: a lo sumo un registro ACTIVO (no failed) por sourceId+cuenta de
    // plataforma — Failed no cuenta, porque tras un fallo el mismo sourceId puede reintentarse
    // con una fila nueva. Un unique index incondicional rompería ese reintento legítimo; el
    // índice parcial (WHERE status != 'failed') solo aplica la unicidad a las filas vivas. La
    // clave es platformAccountId, no organizationId+platform: el mismo sourceId puede
    // republicarse si la organización cambia a otra cuenta de la misma plataforma — "ya
    // publicado" solo es cierto para la cuenta que realmente lo publicó.
    uniqueIndex('published_videos_active_source_id_idx')
      .on(table.platformAccountId, table.sourceId)
      .where(sql`${table.status} != 'failed'`),
  ],
)
