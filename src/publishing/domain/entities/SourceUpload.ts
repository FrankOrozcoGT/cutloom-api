export const SourceUploadStatus = {
  Uploading: 'uploading',
  /** El binario ya está completo en R2 (tus:S3Store) — listo para que cada PublishedVideo de
   * este sourceId (una por plataforma destino) lo lea y publique. */
  Completed: 'completed',
} as const
export type SourceUploadStatus = (typeof SourceUploadStatus)[keyof typeof SourceUploadStatus]

export interface SourceUploadProps {
  id: string
  bulkUploadId: string
  sourceId: string
  /** Id de @tus/server:S3Store para este archivo — es la key real del objeto en R2. Compartido
   * entre todas las plataformas a las que este sourceId se publique: el binario se sube una
   * sola vez sin importar a cuántas plataformas vaya. */
  tusUploadId: string
  status: SourceUploadStatus
  videoSizeBytes: number
  createdAt: Date
}

/**
 * El binario físico de un sourceId dentro de un bulk — uno solo, nunca uno por plataforma (ver
 * PublishedVideo, que sí tiene una fila por plataforma pero todas referencian el mismo
 * SourceUpload). Vive mientras dura la subida; BulkUploadOrchestrator decide qué hacer con cada
 * plataforma recién cuando TODOS los SourceUpload del bulk llegan a Completed.
 */
export class SourceUpload {
  private constructor(private readonly props: SourceUploadProps) {}

  static create(props: SourceUploadProps): SourceUpload {
    return new SourceUpload(props)
  }

  get id(): string {
    return this.props.id
  }

  get bulkUploadId(): string {
    return this.props.bulkUploadId
  }

  get sourceId(): string {
    return this.props.sourceId
  }

  get tusUploadId(): string {
    return this.props.tusUploadId
  }

  get status(): SourceUploadStatus {
    return this.props.status
  }

  get videoSizeBytes(): number {
    return this.props.videoSizeBytes
  }

  get createdAt(): Date {
    return this.props.createdAt
  }
}
