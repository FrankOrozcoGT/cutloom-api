import { AsyncLocalStorage } from 'node:async_hooks'
import { and, eq, gt, isNull, lt, ne, or, sql } from 'drizzle-orm'
import postgres from 'postgres'
import type { Database } from '../../../shared/infrastructure/db/client'
import { youtubeVideos } from '../db/schema'
import { YouTubeVideo, YouTubeVideoStatus } from '../../domain/entities/YouTubeVideo'
import { ActiveUploadAlreadyExistsError, NestedOrganizationLockError } from '../../domain/ports/YouTubeVideoRepository'
import type {
  CreatePendingYouTubeVideoInput,
  YouTubeVideoRepository,
} from '../../domain/ports/YouTubeVideoRepository'

const ACTIVE_SOURCE_ID_CONSTRAINT = 'youtube_videos_active_source_id_idx'

/** true si el error es la violación del unique index parcial de sourceId activo (código 23505 = unique_violation) — Drizzle envuelve el PostgresError real en DrizzleQueryError.cause. */
function isActiveSourceIdViolation(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined
  return cause instanceof postgres.PostgresError && cause.code === '23505' && cause.constraint_name === ACTIVE_SOURCE_ID_CONSTRAINT
}

/** Tipo real del parámetro `tx` que Drizzle pasa al callback de `db.transaction(...)` — se deriva por inferencia en vez de importar tipos internos de drizzle-orm/pg-core, para no acoplarse a su estructura interna entre versiones. */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** Executor estructural mínimo: cualquier valor (Database o Transaction) que soporte estas operaciones sirve como conexión para las queries de este repositorio. */
type Executor = Pick<Database, 'select' | 'insert' | 'update'>

function toEntity(row: typeof youtubeVideos.$inferSelect): YouTubeVideo {
  return YouTubeVideo.create({
    id: row.id,
    organizationId: row.organizationId,
    seriesId: row.seriesId,
    sourceId: row.sourceId,
    videoType: row.videoType,
    metadataRevisionId: row.metadataRevisionId,
    youtubeVideoId: row.youtubeVideoId,
    status: row.status,
    publishAt: row.publishAt,
    createdAt: row.createdAt,
  })
}

export class DrizzleYouTubeVideoRepository implements YouTubeVideoRepository {
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
      // el mismo lock (incluso sin que existan filas youtube_videos todavía para bloquear con
      // FOR UPDATE). Se libera automáticamente al terminar esta transacción (commit o rollback).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`)
      return this.activeTx.run(tx, fn)
    })
  }

  async createManyPending(inputs: CreatePendingYouTubeVideoInput[]): Promise<YouTubeVideo[]> {
    if (inputs.length === 0) return []
    let rows: (typeof youtubeVideos.$inferSelect)[]
    try {
      // El INSERT corre dentro de su propio SAVEPOINT (siempre hay una transacción activa acá:
      // createManyPending solo se llama desde dentro de withOrganizationLock) — si viola el
      // unique constraint, Postgres solo revierte hasta este savepoint, no toda la transacción
      // externa. Sin esto, la transacción entera queda "aborted" tras el error y la query de
      // verificación de más abajo (que necesita seguir usando esa misma transacción, para
      // mantener el lock de organización) fallaría también, ocultando el error real detrás de
      // "current transaction is aborted, commands ignored until end of transaction block".
      rows = await (this.conn as Transaction).transaction(async (savepointTx) => {
        return savepointTx
          .insert(youtubeVideos)
          .values(
            inputs.map((input) => ({
              organizationId: input.organizationId,
              seriesId: input.seriesId,
              sourceId: input.sourceId,
              videoType: input.videoType,
              metadataRevisionId: input.metadataRevisionId,
              youtubeVideoId: null,
              status: YouTubeVideoStatus.Uploading,
              publishAt: input.publishAt,
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
          .select({ sourceId: youtubeVideos.sourceId })
          .from(youtubeVideos)
          .where(
            and(
              eq(youtubeVideos.organizationId, inputs[0]!.organizationId),
              or(...inputs.map((input) => eq(youtubeVideos.sourceId, input.sourceId))),
              ne(youtubeVideos.status, YouTubeVideoStatus.Failed),
            ),
          )
          .limit(1)
        throw new ActiveUploadAlreadyExistsError(conflicting[0]?.sourceId ?? inputs[0]!.sourceId)
      }
      throw error
    }

    if (rows.length !== inputs.length) throw new Error('Failed to create all pending youtube_videos rows')
    return rows.map(toEntity)
  }

  async markUploaded(organizationId: string, id: string, youtubeVideoId: string, status: YouTubeVideoStatus): Promise<YouTubeVideo> {
    const [row] = await this.conn
      .update(youtubeVideos)
      .set({ youtubeVideoId, status })
      .where(and(eq(youtubeVideos.organizationId, organizationId), eq(youtubeVideos.id, id)))
      .returning()

    if (!row) throw new Error(`youtube_videos row not found: ${id}`)
    return toEntity(row)
  }

  async markFailed(organizationId: string, id: string): Promise<YouTubeVideo> {
    const [row] = await this.conn
      .update(youtubeVideos)
      .set({ status: YouTubeVideoStatus.Failed })
      .where(and(eq(youtubeVideos.organizationId, organizationId), eq(youtubeVideos.id, id)))
      .returning()

    if (!row) throw new Error(`youtube_videos row not found: ${id}`)
    return toEntity(row)
  }

  async findOccupyingSlotsByOrganizationId(organizationId: string, now: Date): Promise<YouTubeVideo[]> {
    const rows = await this.conn
      .select()
      .from(youtubeVideos)
      .where(
        and(
          eq(youtubeVideos.organizationId, organizationId),
          ne(youtubeVideos.status, YouTubeVideoStatus.Failed),
          or(
            // Publicación inmediata (Uploading o ya Uploaded, sin publishAt): ya ocupa un
            // slot de la semana en la que se subió — usa createdAt como referencia de semana
            // porque publishAt es null para estos casos.
            isNull(youtubeVideos.publishAt),
            // Scheduling nativo cuya fecha todavía no llegó: ocupa el slot de esa semana futura.
            gt(youtubeVideos.publishAt, now),
          ),
        ),
      )
    return rows.map(toEntity)
  }

  async expireStaleUploading(olderThan: Date): Promise<number> {
    const rows = await this.conn
      .update(youtubeVideos)
      .set({ status: YouTubeVideoStatus.Failed })
      .where(and(eq(youtubeVideos.status, YouTubeVideoStatus.Uploading), lt(youtubeVideos.createdAt, olderThan)))
      .returning({ id: youtubeVideos.id })
    return rows.length
  }
}
