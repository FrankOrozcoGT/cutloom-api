import type { Readable } from 'node:stream'
import type { S3Store } from '@tus/s3-store'
import type { SourceUploadBinaryReader } from '../../domain/ports/SourceUploadBinaryReader'

/**
 * Envuelve la MISMA instancia de S3Store que usa el servidor tus (ver TusBulkUploadHandler) —
 * nunca abre su propio S3Client ni reimplementa la resolución de la key real en R2: S3Store ya
 * sabe cómo leer/borrar un upload por su id, incluyendo los casos donde el objeto quedó
 * fragmentado en partes incompletas.
 */
export class TusS3SourceUploadBinaryReader implements SourceUploadBinaryReader {
  constructor(private readonly store: S3Store) {}

  async open(tusUploadId: string): Promise<Readable> {
    return this.store.read(tusUploadId)
  }

  async size(tusUploadId: string): Promise<number> {
    const upload = await this.store.getUpload(tusUploadId)
    if (upload.size === undefined) {
      throw new Error(`tus upload missing size: ${tusUploadId}`)
    }
    return upload.size
  }

  async delete(tusUploadId: string): Promise<void> {
    try {
      await this.store.remove(tusUploadId)
    } catch {
      // Idempotente: si el objeto ya no existe (reintento tras un delete parcial, o nunca
      // llegó a completarse), no hay nada más que borrar — no se propaga el error.
    }
  }
}
