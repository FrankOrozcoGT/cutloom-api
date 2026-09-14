import type { ContentRevision, YouTubeMetadata } from '../entities/ContentRevision'

export interface CreateContentRevisionInput {
  organizationId: string
  sourceId: string
  prompt: string
  metadata: YouTubeMetadata
}

export interface ContentRevisionRepository {
  findLatestBySourceId(organizationId: string, sourceId: string): Promise<ContentRevision | null>
  /** Trae varias revisiones por id en una sola query — usado por BulkUploadToYouTubeUseCase.prepare() para validar el plan completo en un solo roundtrip. */
  findByIds(organizationId: string, ids: string[]): Promise<ContentRevision[]>
  /** Inserta la siguiente versión (version = última + 1, o 1 si no hay ninguna) — nunca actualiza una revisión existente. */
  create(input: CreateContentRevisionInput): Promise<ContentRevision>
}
