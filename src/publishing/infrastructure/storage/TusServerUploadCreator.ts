import type { S3Store } from '@tus/s3-store'
import { Upload } from '@tus/utils'
import type { CreateTusUploadInput, CreatedTusUpload, TusUploadCreator } from '../../domain/ports/TusUploadCreator'

/**
 * Crea el upload directo contra la MISMA instancia de S3Store que usa el servidor tus (ver
 * TusBulkUploadHandler) — nunca abre su propio S3Client. A diferencia del flujo tus estándar
 * (donde el cliente hace el POST inicial y el servidor decide el id), acá el backend ya conoce
 * el tamaño exacto desde planBulkUpload y necesita devolver la URL ya resuelta en esa misma
 * respuesta — por eso construye el Upload y llama store.create() directamente.
 */
export class TusServerUploadCreator implements TusUploadCreator {
  constructor(
    private readonly store: S3Store,
    private readonly publicBaseUrl: string,
  ) {}

  async createUpload(input: CreateTusUploadInput): Promise<CreatedTusUpload> {
    // @tus/s3-store usa upload.id tal cual como key del objeto en R2, sin ningún prefijo
    // configurable (limitación reconocida del propio paquete) — el único punto de control real
    // de dónde queda el objeto dentro del bucket es construir el id ya con el path deseado. S3
    // (y R2, compatible) trata "/" dentro de una key como un separador de carpeta normal.
    const id = `${input.metadata.organizationId}/${input.metadata.bulkUploadId}/${crypto.randomUUID()}`
    const upload = new Upload({
      id,
      size: input.sizeBytes,
      offset: 0,
      metadata: { bulkUploadId: input.metadata.bulkUploadId, sourceId: input.metadata.sourceId },
    })
    const created = await this.store.create(upload)
    return { id: created.id, url: this.resolveUploadUrl(created.id) }
  }

  resolveUploadUrl(tusUploadId: string): string {
    // tusUploadId ya puede contener "/" (ver createUpload) — encodeURIComponent por segmento
    // para que la URL siga siendo válida sin que el navegador interprete esas barras como un
    // path HTTP distinto antes de llegar al wildcard de Fastify (ver TusBulkUploadHandler).
    const encodedId = tusUploadId.split('/').map(encodeURIComponent).join('/')
    return `${this.publicBaseUrl}/${encodedId}`
  }
}
