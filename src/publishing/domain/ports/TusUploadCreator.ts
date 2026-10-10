export interface CreateTusUploadInput {
  sizeBytes: number
  /** Se adjunta al upload tus (Upload-Metadata) — recuperable en los hooks onUploadCreate/onUploadFinish del servidor tus para resolver a qué SourceUpload corresponde cada evento sin tener que mantener un mapeo aparte. organizationId/bulkUploadId también se usan para construir la key jerárquica del objeto en R2 (ver TusServerUploadCreator) — @tus/s3-store no soporta un prefijo configurable, así que el único punto de control real es el id del Upload mismo. */
  metadata: { organizationId: string; bulkUploadId: string; sourceId: string }
}

export interface CreatedTusUpload {
  /** Id interno que @tus/server:S3Store usa como key del objeto en R2 — lo que se guarda en SourceUpload.tusUploadId. */
  id: string
  /** URL completa que el frontend usa para hacer los PATCH de tus-js-client. */
  url: string
}

/**
 * Crea un upload tus de antemano, en el servidor, ANTES de que el frontend mande ningún byte —
 * distinto del flujo tus estándar (donde el cliente hace el POST inicial): acá el backend ya
 * sabe el tamaño exacto y necesita devolver la URL ya resuelta como parte de la respuesta de
 * planBulkUpload, en el mismo roundtrip que crea el resto del plan.
 */
export interface TusUploadCreator {
  createUpload(input: CreateTusUploadInput): Promise<CreatedTusUpload>
  /** Reconstruye la URL pública tus a partir de un tusUploadId ya existente — usado al resumir un plan (ver PlanBulkUploadUseCase), sin crear un upload nuevo en el store. */
  resolveUploadUrl(tusUploadId: string): string
}
