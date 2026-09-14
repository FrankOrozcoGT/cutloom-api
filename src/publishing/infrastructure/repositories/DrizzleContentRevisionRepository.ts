import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { contentRevisions } from '../db/schema'
import { ContentRevision, parseYouTubeMetadata } from '../../domain/entities/ContentRevision'
import type { ContentRevisionRepository, CreateContentRevisionInput } from '../../domain/ports/ContentRevisionRepository'

function toEntity(row: typeof contentRevisions.$inferSelect): ContentRevision {
  return ContentRevision.create({
    id: row.id,
    organizationId: row.organizationId,
    sourceId: row.sourceId,
    version: row.version,
    prompt: row.prompt,
    // metadata es jsonb sin schema de validación en Postgres — se valida acá al leerla, mismo
    // validador que usa DeepSeekMetadataProvider al recibirla del LLM (ver ContentRevision.ts).
    metadata: parseYouTubeMetadata(row.metadata),
    createdAt: row.createdAt,
  })
}

export class DrizzleContentRevisionRepository implements ContentRevisionRepository {
  constructor(private readonly db: Database) {}

  async findLatestBySourceId(organizationId: string, sourceId: string): Promise<ContentRevision | null> {
    const [row] = await this.db
      .select()
      .from(contentRevisions)
      .where(and(eq(contentRevisions.organizationId, organizationId), eq(contentRevisions.sourceId, sourceId)))
      .orderBy(desc(contentRevisions.version))
      .limit(1)

    return row ? toEntity(row) : null
  }

  async findByIds(organizationId: string, ids: string[]): Promise<ContentRevision[]> {
    if (ids.length === 0) return []
    const rows = await this.db
      .select()
      .from(contentRevisions)
      .where(and(eq(contentRevisions.organizationId, organizationId), inArray(contentRevisions.id, ids)))
    return rows.map(toEntity)
  }

  async create(input: CreateContentRevisionInput): Promise<ContentRevision> {
    return this.db.transaction(async (tx) => {
      // SELECT ... FOR UPDATE sobre las filas existentes de este (organizationId, sourceId)
      // serializa generaciones concurrentes del mismo video dentro de la misma organización,
      // evitando que dos requests calculen el mismo MAX(version)+1 y choquen contra el unique
      // index (organization_id, source_id, version). Filtrar también por organizationId (no
      // solo sourceId) evita contaminar el versionado si dos organizaciones distintas llegan
      // a compartir el mismo sourceId (sin FK que lo impida, viene de otro bounded context).
      const [latest] = await tx
        .select({ version: contentRevisions.version })
        .from(contentRevisions)
        .where(and(eq(contentRevisions.organizationId, input.organizationId), eq(contentRevisions.sourceId, input.sourceId)))
        .orderBy(desc(contentRevisions.version))
        .limit(1)
        .for('update')

      const [row] = await tx
        .insert(contentRevisions)
        .values({
          organizationId: input.organizationId,
          sourceId: input.sourceId,
          version: (latest?.version ?? 0) + 1,
          prompt: input.prompt,
          metadata: input.metadata,
        })
        .returning()

      if (!row) throw new Error(`Failed to create content revision for ${input.sourceId}`)
      return toEntity(row)
    })
  }
}
