import type { Readable } from 'node:stream'

/**
 * Lectura/borrado del binario que tus ya dejó completo en R2 (ver SourceUpload.tusUploadId) —
 * nunca escribe: tus:S3Store es el único punto que pone bytes ahí. Usado tanto por YouTube
 * (lee en streaming para subir a la Data API) como por el cron de TikTok (lee cuando llega
 * publishAt) y por la limpieza tras publicar o tras expirar un bulk.
 */
export interface SourceUploadBinaryReader {
  open(tusUploadId: string): Promise<Readable>
  size(tusUploadId: string): Promise<number>
  /** Idempotente: no falla si el objeto ya no existe (ej. reintento tras un delete parcial). */
  delete(tusUploadId: string): Promise<void>
}
