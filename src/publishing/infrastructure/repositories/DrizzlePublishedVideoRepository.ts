import { AsyncLocalStorage } from 'node:async_hooks'
import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import postgres from 'postgres'
import type { Database } from '../../../shared/infrastructure/db/client'
import { publishedVideos } from '../db/schema'
import { PublishedVideo, PublishedVideoStatus } from '../../domain/entities/PublishedVideo'
import { PublishedVideoType } from '../../domain/entities/PublishedVideo'
import type { VideoPlatform, PublishedVideoStatus as PublishedVideoStatusType } from '../../domain/entities/PublishedVideo'
import { ActiveUploadAlreadyExistsError, NestedOrganizationLockError } from '../../domain/ports/PublishedVideoRepository'
import type {
  CreateAwaitingUploadInput,
  PublishedVideoRepository,
} from '../../domain/ports/PublishedVideoRepository'

const ACTIVE_SOURCE_ID_CONSTRAINT = 'published_videos_active_source_id_idx'

/** true si el error es la violación del unique index parcial de sourceId activo (código 23505 = unique_violation) — Drizzle envuelve el PostgresError real en DrizzleQueryError.cause. */
function isActiveSourceIdViolation(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined
  return cause instanceof postgres.PostgresError && cause.code === '23505' && cause.constraint_name === ACTIVE_SOURCE_ID_CONSTRAINT
}

/** Tipo real del parámetro `tx` que Drizzle pasa al callback de `db.transaction(...)` — se deriva por inferencia en vez de importar tipos internos de drizzle-orm/pg-core, para no acoplarse a su estructura interna entre versiones. */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** Executor estructural mínimo: cualquier valor (Database o Transaction) que soporte estas operaciones sirve como conexión para las queries de este repositorio. */
type Executor = Pick<Database, 'select' | 'insert' | 'update'>

function toEntity(row: typeof publishedVideos.$inferSelect): PublishedVideo {
  return PublishedVideo.create({
    id: row.id,
    organizationId: row.organizationId,
    platform: row.platform,
    platformAccountId: row.platformAccountId,
    sourceUploadId: row.sourceUploadId,
    seriesId: row.seriesId,
    sourceId: row.sourceId,
    videoType: row.videoType,
    priority: row.priority,
    longVideoTimestampSec: row.longVideoTimestampSec,
    longVideoUrl: row.longVideoUrl,
    metadataRevisionId: row.metadataRevisionId,
    platformVideoId: row.platformVideoId,
    publishId: row.publishId,
    status: row.status,
    publishAt: row.publishAt,
    platformOptions: row.platformOptions as Record<string, unknown> | null,
    createdAt: row.createdAt,
  })
}

export class DrizzlePublishedVideoRepository implements PublishedVideoRepository {
  // Propaga la transacción abierta por withOrganizationLock hacia el resto de métodos de esta
  // misma instancia sin tener que pasarla explícitamente por cada firma del puerto de dominio
  // (que no debe conocer nada de transacciones de Drizzle) — mientras hay un lock activo en
  // el async context actual, todas las queries de este repositorio corren dentro de esa misma
  // transacción/conexión, en vez de tomar una conexión nueva del pool.
  private readonly activeTx = new AsyncLocalStorage<Transaction>()

  constructor(private readonly db: Database) {}

  private get conn(): Executor {
    return this.activeTx.getStore() ?? this.db
  }

  async withOrganizationLock<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    if (this.activeTx.getStore()) {
      // Anidar tomaría una segunda conexión del pool y un segundo advisory lock para la
      // misma organización desde el mismo request lógico — la conexión externa (que ya tiene
      // el lock) quedaría esperando a que `fn` retorne, mientras `fn` espera un lock que la
      // propia conexión externa nunca va a soltar: un self-deadlock silencioso. Se falla
      // rápido y explícito en vez de colgar el request indefinidamente.
      throw new NestedOrganizationLockError()
    }
    return this.db.transaction(async (tx) => {
      // hashtext() es determinístico y built-in de Postgres — convierte el UUID a un bigint
      // estable para pg_advisory_xact_lock, que serializa cualquier otra transacción que pida
      // el mismo lock (incluso sin que existan filas published_videos todavía para bloquear con
      // FOR UPDATE). Se libera automáticamente al terminar esta transacción (commit o rollback).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`)
      return this.activeTx.run(tx, fn)
    })
  }

  async createManyAwaitingUpload(inputs: CreateAwaitingUploadInput[]): Promise<PublishedVideo[]> {
    if (inputs.length === 0) return []
    let rows: (typeof publishedVideos.$inferSelect)[]
    try {
      // El INSERT corre dentro de su propio SAVEPOINT (siempre hay una transacción activa acá:
      // createManyAwaitingUpload solo se llama desde dentro de withOrganizationLock) — si viola
      // el unique constraint, Postgres solo revierte hasta este savepoint, no toda la
      // transacción externa. Sin esto, la transacción entera queda "aborted" tras el error y la
      // query de verificación de más abajo (que necesita seguir usando esa misma transacción,
      // para mantener el lock de organización) fallaría también, ocultando el error real detrás
      // de "current transaction is aborted, commands ignored until end of transaction block".
      rows = await (this.conn as Transaction).transaction(async (savepointTx) => {
        return savepointTx
          .insert(publishedVideos)
          .values(
            inputs.map((input) => ({
              organizationId: input.organizationId,
              platform: input.platform,
              platformAccountId: input.platformAccountId,
              sourceUploadId: input.sourceUploadId,
              seriesId: input.seriesId,
              sourceId: input.sourceId,
              videoType: input.videoType,
              priority: input.priority,
              longVideoTimestampSec: input.longVideoTimestampSec,
              longVideoUrl: input.longVideoUrl,
              metadataRevisionId: input.metadataRevisionId,
              platformVideoId: null,
              publishId: null,
              status: PublishedVideoStatus.AwaitingUpload,
              publishAt: null,
              platformOptions: input.platformOptions,
            })),
          )
          .returning()
      })
    } catch (error) {
      if (isActiveSourceIdViolation(error)) {
        // Postgres no identifica cuál fila del batch violó el constraint — se resuelve con
        // una query de verificación aparte, solo en el camino de error (no agrega costo al
        // camino feliz), para reportar el sourceId real en vez de un error genérico de INSERT.
        const conflicting = await this.conn
          .select({ sourceId: publishedVideos.sourceId })
          .from(publishedVideos)
          .where(
            and(
              or(
                ...inputs.map((input) =>
                  and(
                    eq(publishedVideos.sourceId, input.sourceId),
                    eq(publishedVideos.platformAccountId, input.platformAccountId),
                  ),
                ),
              ),
              ne(publishedVideos.status, PublishedVideoStatus.Failed),
            ),
          )
          .limit(1)
        throw new ActiveUploadAlreadyExistsError(conflicting[0]?.sourceId ?? inputs[0]!.sourceId)
      }
      throw error
    }

    if (rows.length !== inputs.length) throw new Error('Failed to create all AwaitingUpload published_videos rows')
    return rows.map(toEntity)
  }

  async findBySourceUploadId(sourceUploadId: string): Promise<PublishedVideo[]> {
    const rows = await this.conn.select().from(publishedVideos).where(eq(publishedVideos.sourceUploadId, sourceUploadId))
    return rows.map(toEntity)
  }

  async findBySourceUploadIds(sourceUploadIds: string[]): Promise<PublishedVideo[]> {
    if (sourceUploadIds.length === 0) return []
    const rows = await this.conn.select().from(publishedVideos).where(inArray(publishedVideos.sourceUploadId, sourceUploadIds))
    return rows.map(toEntity)
  }

  async findBySourceId(sourceId: string): Promise<PublishedVideo[]> {
    const rows = await this.conn.select().from(publishedVideos).where(eq(publishedVideos.sourceId, sourceId))
    return rows.map(toEntity)
  }

  async findBySourceIds(sourceIds: string[]): Promise<PublishedVideo[]> {
    if (sourceIds.length === 0) return []
    const rows = await this.conn.select().from(publishedVideos).where(inArray(publishedVideos.sourceId, sourceIds))
    return rows.map(toEntity)
  }

  async assignScheduleAndStartPublishing(
    id: string,
    publishAt: Date | null,
    nextStatus: typeof PublishedVideoStatus.Publishing | typeof PublishedVideoStatus.Scheduled,
  ): Promise<PublishedVideo> {
    const [row] = await this.conn
      .update(publishedVideos)
      .set({ status: nextStatus, publishAt })
      .where(eq(publishedVideos.id, id))
      .returning()

    if (!row) throw new Error(`published_videos row not found: ${id}`)
    return toEntity(row)
  }

  async markUploaded(
    organizationId: string,
    id: string,
    platformVideoId: string | null,
    status: PublishedVideoStatusType,
    publishId: string | null,
  ): Promise<PublishedVideo> {
    const [row] = await this.conn
      .update(publishedVideos)
      .set({ platformVideoId, status, publishId })
      .where(and(eq(publishedVideos.organizationId, organizationId), eq(publishedVideos.id, id)))
      .returning()

    if (!row) throw new Error(`published_videos row not found: ${id}`)
    return toEntity(row)
  }

  async markFailed(organizationId: string, id: string): Promise<PublishedVideo> {
    const [row] = await this.conn
      .update(publishedVideos)
      .set({ status: PublishedVideoStatus.Failed })
      .where(and(eq(publishedVideos.organizationId, organizationId), eq(publishedVideos.id, id)))
      .returning()

    if (!row) throw new Error(`published_videos row not found: ${id}`)
    return toEntity(row)
  }

  async claimScheduledForUpload(organizationId: string, id: string): Promise<PublishedVideo | null> {
    // UPDATE condicional (WHERE status='scheduled') en vez de un SELECT + UPDATE separados: la
    // única fuente de atomicidad frente a dos ejecuciones concurrentes del cron es que Postgres
    // solo deje a una de las dos transacciones ganar esta fila.
    const [row] = await this.conn
      .update(publishedVideos)
      .set({ status: PublishedVideoStatus.Publishing })
      .where(
        and(
          eq(publishedVideos.organizationId, organizationId),
          eq(publishedVideos.id, id),
          eq(publishedVideos.status, PublishedVideoStatus.Scheduled),
        ),
      )
      .returning()

    return row ? toEntity(row) : null
  }

  async findOccupyingSlotsByOrganizationId(organizationId: string, platform: VideoPlatform, now: Date): Promise<PublishedVideo[]> {
    const rows = await this.conn
      .select()
      .from(publishedVideos)
      .where(
        and(
          eq(publishedVideos.organizationId, organizationId),
          eq(publishedVideos.platform, platform),
          ne(publishedVideos.status, PublishedVideoStatus.Failed),
          // AwaitingUpload no ocupa slot todavía: ese bulk ni siquiera terminó de subir, no hay
          // garantía de que llegue a calendarizarse — recién pasa a ocupar un slot real cuando
          // assignScheduleAndStartPublishing lo mueve a Publishing/Scheduled con su publishAt ya
          // calculado (ver BulkUploadOrchestrator).
          ne(publishedVideos.status, PublishedVideoStatus.AwaitingUpload),
          or(
            // Publicación inmediata (Publishing/Uploaded/Inbox, sin publishAt): ya ocupa un
            // slot de la semana en la que se subió — usa createdAt como referencia porque
            // publishAt es null para estos casos.
            isNull(publishedVideos.publishAt),
            // Scheduling cuya fecha todavía no llegó: ocupa el slot de esa semana futura.
            gt(publishedVideos.publishAt, now),
          ),
        ),
      )
    return rows.map(toEntity)
  }

  async findPublishedLongVideoInSeries(seriesId: string, platform: VideoPlatform): Promise<PublishedVideo | null> {
    const [row] = await this.conn
      .select()
      .from(publishedVideos)
      .where(
        and(
          eq(publishedVideos.seriesId, seriesId),
          eq(publishedVideos.platform, platform),
          eq(publishedVideos.videoType, PublishedVideoType.Long),
          isNotNull(publishedVideos.platformVideoId),
        ),
      )
      .limit(1)
    return row ? toEntity(row) : null
  }

  async findDueScheduled(platform: VideoPlatform, now: Date): Promise<PublishedVideo[]> {
    const rows = await this.db
      .select()
      .from(publishedVideos)
      .where(
        and(
          eq(publishedVideos.platform, platform),
          eq(publishedVideos.status, PublishedVideoStatus.Scheduled),
          lt(publishedVideos.publishAt, now),
        ),
      )
    return rows.map(toEntity)
  }

  async findByPublishId(publishId: string): Promise<PublishedVideo | null> {
    const [row] = await this.db.select().from(publishedVideos).where(eq(publishedVideos.publishId, publishId)).limit(1)
    return row ? toEntity(row) : null
  }
}
