import { isRecord } from '../../../shared/domain/validation'

export interface YouTubeMetadata {
  title: string
  description: string
  tags: string[]
  categoryId: string
  thumbnailIdeas: string[]
}

export class InvalidYouTubeMetadataError extends Error {
  constructor() {
    super('Value does not match the expected YouTubeMetadata shape')
    this.name = 'InvalidYouTubeMetadataError'
  }
}

/**
 * Único punto de validación de forma para YouTubeMetadata, sea cual sea su origen (respuesta
 * del LLM, columna jsonb leída de BD) — de aquí en adelante el tipo se propaga sin recastear.
 */
export function parseYouTubeMetadata(value: unknown): YouTubeMetadata {
  if (
    !isRecord(value) ||
    typeof value.title !== 'string' ||
    typeof value.description !== 'string' ||
    !Array.isArray(value.tags) ||
    !value.tags.every((t) => typeof t === 'string') ||
    typeof value.categoryId !== 'string' ||
    !Array.isArray(value.thumbnailIdeas) ||
    !value.thumbnailIdeas.every((t) => typeof t === 'string')
  ) {
    throw new InvalidYouTubeMetadataError()
  }
  return {
    title: value.title,
    description: value.description,
    tags: value.tags,
    categoryId: value.categoryId,
    thumbnailIdeas: value.thumbnailIdeas,
  }
}

export interface ContentRevisionProps {
  id: string
  organizationId: string
  sourceId: string
  version: number
  prompt: string
  metadata: YouTubeMetadata
  createdAt: Date
}

/**
 * Append-only: nunca se actualiza una revisión existente, cada iteración con la IA
 * agrega una fila nueva con version = anterior + 1. "Última versión" siempre gana
 * para publicar (ver GenerateYouTubeMetadataUseCase y BulkUploadToYouTubeUseCase).
 */
export class ContentRevision {
  private constructor(private readonly props: ContentRevisionProps) {}

  static create(props: ContentRevisionProps): ContentRevision {
    return new ContentRevision(props)
  }

  get id(): string {
    return this.props.id
  }

  get organizationId(): string {
    return this.props.organizationId
  }

  get sourceId(): string {
    return this.props.sourceId
  }

  get version(): number {
    return this.props.version
  }

  get prompt(): string {
    return this.props.prompt
  }

  get metadata(): YouTubeMetadata {
    return this.props.metadata
  }

  get createdAt(): Date {
    return this.props.createdAt
  }
}
