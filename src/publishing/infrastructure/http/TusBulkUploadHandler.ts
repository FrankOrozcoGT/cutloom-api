import type { FastifyInstance } from 'fastify'
import { Server as TusServer, EVENTS, MemoryLocker } from '@tus/server'
import { S3Store } from '@tus/s3-store'
import { corsOrigins } from '../../../shared/infrastructure/config/corsOrigins'
import type { Logger } from '../../../shared/domain/ports/Logger'

export interface TusBulkUploadHandlerOptions {
  path: string
  bucket: string
  accountId: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * Expone el protocolo tus (resumable uploads) para subir el binario de un SourceUpload, directo
 * a R2 vía S3Store — el backend nunca bufferiza el archivo completo en disco propio, cada PATCH
 * se reenvía a R2 en cuanto llega. No conoce BulkUploadOrchestrator ni published_videos (sería
 * una dependencia circular: el orchestrator necesita leer del mismo S3Store que este handler
 * expone) — en vez de recibirlo en el constructor, expone onActivity/onCompleted para que el
 * composition root los conecte después de construir ambos (ver publishingComposition.ts).
 */
export class TusBulkUploadHandler {
  readonly store: S3Store
  private readonly tusServer: TusServer

  constructor(
    options: TusBulkUploadHandlerOptions,
    private readonly logger: Logger,
  ) {
    this.store = new S3Store({
      s3ClientConfig: {
        bucket: options.bucket,
        region: 'auto',
        endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
        // Desde aws-sdk-js-v3 3.729.0 el default es calcular un checksum del body usando
        // aws-chunked encoding, que exige que cada sub-chunk interno (salvo el último) mida al
        // menos 8192 bytes. @tus/s3-store sube cada parte leyéndola de un archivo temporal en
        // disco (StreamSplitter) — en una subida de red lenta esa lectura puede entregar un
        // sub-chunk intermedio más chico, y el SDK aborta la conexión a mitad de camino en vez
        // de esperar más datos. R2 ve eso como el stream cortado y responde IncompleteBody /
        // "socket connection was closed unexpectedly" (confirmado en aislamiento con un script
        // mínimo igual al tutorial oficial de tus, sin ninguna configuración propia: el mismo
        // fallo ocurre con @tus/s3-store puro, y desaparece solo con este flag). WHEN_REQUIRED
        // vuelve al comportamiento de antes de esa versión: solo calcula el checksum si el
        // propio request lo exige explícitamente.
        requestChecksumCalculation: 'WHEN_REQUIRED',
      },
      // Default de @tus/s3-store es 60 — cada parte en vuelo mantiene su propio stream de
      // lectura de disco (tmpdir) + buffer de red hacia R2 simultáneamente. Con varios archivos
      // subiendo en paralelo (ver MAX_VIDEOS_PER_BULK), 60 partes concurrentes reales es
      // demasiada presión de memoria/IO para el droplet real (1 vCPU/1GB) — un valor bajo reduce
      // el paralelismo interno sin afectar la funcionalidad, solo la velocidad de cada parte.
      maxConcurrentPartUploads: 6,
    })

    this.tusServer = new TusServer({
      path: options.path,
      datastore: this.store,
      locker: new MemoryLocker(),
      // El id del upload incluye "/" a propósito (organizationId/bulkUploadId/uuid — ver
      // TusServerUploadCreator, para que la key quede organizada en R2 en vez de suelta en la
      // raíz del bucket). El default de @tus/server RECHAZA cualquier id con "/" (lo trata como
      // ataque de path traversal) y solo toma el último segmento de la URL — hay que extraer el
      // id completo nosotros mismos, todo lo que sigue después del prefix configurado.
      getFileIdFromRequest: (req) => {
        const url = new URL(req.url, 'http://localhost')
        const prefix = `${options.path}/`
        if (!url.pathname.startsWith(prefix)) return undefined
        const id = decodeURIComponent(url.pathname.slice(prefix.length))
        // Blindaje real (no cosmético): sin esto, un id con ".." podría escapar del prefijo
        // organizationId/bulkUploadId/ pensado y apuntar a un objeto arbitrario del bucket.
        if (!id || id.includes('..') || id.includes('\0')) return undefined
        return id
      },
      // Dispara POST_RECEIVE periódicamente durante una subida en curso (no solo al terminar) —
      // es la única señal de "actividad real" disponible mientras el archivo sigue subiendo.
      postReceiveInterval: 5000,
      // @tus/server maneja su propio preflight (OPTIONS) internamente, sin pasar por el plugin
      // @fastify/cors registrado en server.ts — sin esto, su default no autoriza PATCH/DELETE
      // (los verbos reales de tus-js-client) y el preflight falla con
      // MethodDisallowedByPreflightResponse. Mismos orígenes que el resto de la API.
      allowedOrigins: corsOrigins(),
      allowedCredentials: true,
      // Headers que tus-js-client manda en cada request — Authorization para authMiddleware,
      // el resto son del protocolo tus en sí (Upload-Metadata para bulkUploadId/sourceId).
      allowedHeaders: ['Authorization', 'Content-Type', 'Tus-Resumable', 'Upload-Length', 'Upload-Metadata', 'Upload-Offset'],
      // El error real (ej. el motivo de fondo detrás de "An error was encountered in a
      // non-retryable streaming request" del AWS SDK al escribir a R2) solo se conoce acá —
      // @tus/server, sin esto, solo responde el código HTTP genérico al cliente sin loguear
      // nada del lado del servidor. Captura la causa completa para poder diagnosticar fallos de
      // red/R2 reales en vez de adivinar a partir del mensaje genérico del SDK.
      onResponseError: (_req, err) => {
        this.logger.error(
          {
            error:
              err instanceof Error
                ? { message: err.message, stack: err.stack, cause: err.cause }
                : err,
          },
          '[TusBulkUploadHandler] request failed',
        )
        return undefined
      },
    })
  }

  /** Cualquier PATCH real recibido, incluso a mitad de una subida en curso — ver bulkUploads.lastActivityAt. */
  onActivity(listener: (tusUploadId: string, now: Date) => void): void {
    this.tusServer.on(EVENTS.POST_RECEIVE, (_req, upload) => listener(upload.id, new Date()))
  }

  /** Un archivo individual terminó de subir (el objeto ya está completo en R2). */
  onCompleted(listener: (tusUploadId: string) => void): void {
    this.tusServer.on(EVENTS.POST_FINISH, (_req, _res, upload) => listener(upload.id))
  }

  registerRoutes(app: FastifyInstance, prefix: string): void {
    // Default de Fastify es 1MB — mucho menor que un video real (hasta 20GiB, ver
    // MAX_VIDEO_FILE_SIZE_BYTES_BY_TYPE). Aunque el content-type parser de este scope es
    // pass-through (no consume el body), Fastify igual trunca el stream de entrada al
    // bodyLimit ANTES de que @tus/server pueda leerlo — eso es lo que producía el error
    // "IncompleteBody" del SDK de AWS al subir a R2 (el Content-Length real del PATCH no
    // coincidía con los bytes que Fastify dejaba pasar). Fastify exige un entero > 0 (0 no es
    // válido, ver FST_ERR_ROUTE_BODY_LIMIT_OPTION_NOT_INT) — 20GiB cubre el archivo más grande
    // permitido por el dominio, el PATCH individual de un chunk nunca se acerca a ese tamaño.
    const options = { bodyLimit: 20 * 1024 * 1024 * 1024 }
    // @tus/server implementa los 6 métodos del protocolo (POST/HEAD/PATCH/GET/OPTIONS/DELETE)
    // sobre handlers nativos de Node (req/res crudos) — server.handle() ya sabe despachar según
    // el método, por eso un único wildcard alcanza en vez de una ruta por verbo.
    app.all(`${prefix}/*`, options, (req, reply) => this.tusServer.handle(req.raw, reply.raw))
    app.all(prefix, options, (req, reply) => this.tusServer.handle(req.raw, reply.raw))
  }
}
