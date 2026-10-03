import type { Readable } from 'node:stream'
import { pipeline, Transform } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ScheduleCapacityExceededError } from '../../application/services/ScheduleUploadPlanService'
import {
  BulkUploadSession,
  BulkUploadVideoUseCase,
  MAX_VIDEO_FILE_SIZE_BYTES_BY_TYPE,
  MAX_VIDEOS_PER_BULK,
  MetadataRevisionNotFoundError,
  MetadataRevisionSourceMismatchError,
  TooManyVideosError,
  type BulkUploadItemResult,
  type BulkUploadPlanItem,
} from '../../application/use-cases/BulkUploadVideoUseCase'
import { PublishedVideoType, VideoPlatform } from '../../domain/entities/PublishedVideo'
import { ActiveUploadAlreadyExistsError } from '../../domain/ports/PublishedVideoRepository'
import { NoPlatformConnectionError } from '../../domain/ports/PlatformCredentialResolver'
import { VideoUploadRejectedError, VideoUploadQuotaExceededError, VideoUploadTokenExpiredError } from '../../domain/ports/VideoUploader'
import type { Logger } from '../../../shared/domain/ports/Logger'
import { isRecord } from '../../../shared/domain/validation'
import { InvalidRequestError, isVideoPlatform } from './httpValidation'

export class VideoFileTooLargeError extends Error {
  constructor(sourceId: string, contentType: string, maxBytes: number) {
    super(`Video file for sourceId "${sourceId}" (${contentType}) exceeds the ${maxBytes} bytes limit for that content type`)
    this.name = 'VideoFileTooLargeError'
  }
}

interface BulkUploadPayloadLongItem {
  sourceId: string
  metadataRevisionId: string
  videoType: typeof PublishedVideoType.Long
  /** Tamaño real del archivo en bytes, declarado por el frontend — algunas plataformas (TikTok) exigen conocerlo antes de leer el stream (init con video_size/chunk_size/total_chunk_count). Se valida contra los bytes reales del stream a medida que llega (ver boundStreamSize). */
  videoSize: number
  platformOptions?: Record<string, unknown>
}

interface BulkUploadPayloadShortItem {
  sourceId: string
  metadataRevisionId: string
  videoType: typeof PublishedVideoType.Short
  /** Score de shorts-intelligence (0-1) — obligatorio para shorts, decide el orden de calendarización. */
  score: number
  videoSize: number
  platformOptions?: Record<string, unknown>
  /** Segundo exacto donde arranca este short dentro de su video largo — lo devuelve el endpoint de generar shorts; el frontend lo guarda y lo reenvía acá para construir el link "2 minutos antes" en la descripción. Opcional: si no viene, no se agrega ningún link. */
  longVideoTimestampSec?: number
  /** URL del video largo ya publicado — solo necesario si ese largo no viene en este mismo lote (ej. ya se subió antes, o esta plataforma nunca sube el largo). Opcional. */
  longVideoUrl?: string
}

type BulkUploadPayloadItem = BulkUploadPayloadLongItem | BulkUploadPayloadShortItem

interface BulkUploadPayload {
  seriesId: string
  timeZone: string
  /**
   * Día calendario propuesto para el video largo de esta serie (o el único día de
   * referencia si no hay largo en este bulk). Opcional: si no viene, se usa hoy como
   * candidato — ScheduleUploadPlanService ya corre la fecha hacia adelante hasta
   * encontrar el primer hueco real, así que "hoy" siempre resuelve a la fecha más
   * conveniente y cercana posible según el estado actual de la cola de la organización.
   */
  longVideoPublishDay: string | null
  items: BulkUploadPayloadItem[]
}

function isBulkUploadPayloadItem(value: unknown): value is BulkUploadPayloadItem {
  if (!isRecord(value)) return false
  if (typeof value.sourceId !== 'string' || typeof value.metadataRevisionId !== 'string' || typeof value.videoSize !== 'number') return false
  if (value.platformOptions !== undefined && !isRecord(value.platformOptions)) return false

  if (value.videoType === PublishedVideoType.Long) return true
  if (value.videoType === PublishedVideoType.Short) {
    if (typeof value.score !== 'number') return false
    if (value.longVideoTimestampSec !== undefined && typeof value.longVideoTimestampSec !== 'number') return false
    if (value.longVideoUrl !== undefined && typeof value.longVideoUrl !== 'string') return false
    return true
  }
  return false
}

/** Único punto de validación del JSON crudo del campo "payload" del multipart — de aquí en adelante el tipo se propaga sin recastear. */
function parseBulkUploadPayload(raw: string): BulkUploadPayload {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new InvalidRequestError('"payload" is not valid JSON')
  }
  if (!isRecord(value)) {
    throw new InvalidRequestError('"payload" must be a JSON object')
  }
  const items = value.items
  if (!Array.isArray(items) || items.length === 0 || !items.every(isBulkUploadPayloadItem)) {
    throw new InvalidRequestError(
      '"payload.items" must be a non-empty array of {sourceId,metadataRevisionId,videoType,score?,platformOptions?,longVideoTimestampSec?,longVideoUrl?}',
    )
  }
  if (typeof value.seriesId !== 'string' || typeof value.timeZone !== 'string') {
    throw new InvalidRequestError('"payload" must include seriesId and timeZone')
  }
  if (value.longVideoPublishDay !== undefined && typeof value.longVideoPublishDay !== 'string') {
    throw new InvalidRequestError('"payload.longVideoPublishDay" must be a string when present')
  }
  return {
    seriesId: value.seriesId,
    timeZone: value.timeZone,
    longVideoPublishDay: value.longVideoPublishDay ?? null,
    items,
  }
}

/** Fieldname que el frontend usa para el archivo de video de un item — un archivo por sourceId, sin importar la plataforma. */
function videoFieldName(sourceId: string): string {
  return `video_${sourceId}`
}

/**
 * @fastify/multipart solo permite un fileSize global por request (no distinto por archivo) —
 * este wrapper cuenta bytes en tiempo real y aborta con VideoFileTooLargeError en cuanto un
 * item específico excede su límite real, sin esperar a que termine de subirse un archivo
 * entero que ya sabemos que va a exceder el límite.
 *
 * Se usa un Transform (no un PassThrough con listeners manuales de 'data'/'write') más
 * `pipeline()` para que Node maneje backpressure de forma nativa: si el consumidor final (el
 * VideoUploader de la plataforma) lee más lento que el multipart entrante, `pipeline()` pausa
 * la fuente automáticamente en vez de acumular chunks sin techo en el buffer interno del
 * stream — así el video nunca se bufferiza completo en memoria, ni siquiera bajo diferencias
 * de velocidad sostenidas entre origen y destino.
 */
interface BoundStream {
  stream: Readable
  /**
   * Se resuelve cuando el pipeline termina bien, se rechaza con el error real (incluyendo
   * VideoFileTooLargeError) si falla. No hay que confiar en que el consumidor del stream
   * detecte y propague correctamente el evento 'error' del stream — eso depende de
   * comportamiento interno de una librería de terceros no verificado. En cambio, el caller
   * debe correr la operación que consume `stream` en una carrera (Promise.race) contra este
   * `done`, así el error del stream siempre gana y nunca queda un request colgado ni un
   * upload silenciosamente truncado.
   */
  done: Promise<void>
}

function boundStreamSize(source: Readable, maxBytes: number, sourceId: string, logger: Logger): BoundStream {
  let bytesRead = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesRead += chunk.length
      if (bytesRead > maxBytes) {
        callback(new VideoFileTooLargeError(sourceId, 'video', maxBytes))
        return
      }
      callback(null, chunk)
    },
  })
  const done = new Promise<void>((resolve, reject) => {
    // pipeline() propaga errores de cualquiera de los dos lados hacia `counter` (el stream
    // que se devuelve y consume después) y limpia ambos extremos — sin esto, un error en
    // `source` dejaría `counter` colgado esperando datos que nunca llegan. El callback es la
    // única fuente de verdad de si el streaming falló: se usa para resolver/rechazar `done`,
    // en vez de depender de que el consumidor externo del stream detecte el error por su cuenta.
    pipeline(source, counter, (error) => {
      if (error) {
        logger.error({ sourceId, error: error.message }, '[BulkUploadController] boundStreamSize failed')
        reject(error)
        return
      }
      resolve()
    })
  })
  return { stream: counter, done }
}

export class BulkUploadController {
  constructor(
    private readonly bulkUploadVideoUseCaseByPlatform: Record<VideoPlatform, BulkUploadVideoUseCase>,
    private readonly logger: Logger,
  ) {}

  /**
   * multipart/form-data: el campo de texto "payload" (JSON con seriesId, timeZone,
   * longVideoPublishDay, e items: sourceId, metadataRevisionId, videoType, score opcional,
   * platformOptions opcional) DEBE ir antes que los archivos de video en el multipart — cada
   * archivo se streamea directo a la plataforma en cuanto llega (ver cada VideoUploader), así
   * que necesitamos conocer el plan completo antes del primer archivo. La calendarización
   * (publishAt por item) se calcula dentro de BulkUploadVideoUseCase.prepare(), no acá — este
   * controller solo parsea el transporte HTTP. Un archivo por item, nombrado "video_<sourceId>"
   * (ver videoFieldName). La misma implementación de este método sirve para cualquier
   * plataforma — solo cambia qué instancia de BulkUploadVideoUseCase se invoca según :platform.
   */
  async bulkUpload(req: FastifyRequest, reply: FastifyReply) {
    const { platform } = req.params as { platform: string }
    if (!isVideoPlatform(platform)) {
      return reply.status(404).send({ error: 'UNKNOWN_PLATFORM' })
    }
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }
    const organizationId = req.organizationId
    const useCase = this.bulkUploadVideoUseCaseByPlatform[platform]
    const results: BulkUploadItemResult[] = []

    try {
      let plan: BulkUploadPlanItem[] | undefined
      let session: BulkUploadSession | undefined
      const pendingSourceIds = new Set<string>()

      // El parser del multipart solo admite un fileSize global (no distinto por parte) — se
      // configura con el límite más permisivo (long) y cada archivo se valida contra el
      // límite real de su propio videoType a medida que se streamea, sin esperar a que
      // termine de subir para descubrir que era demasiado grande.
      for await (const part of req.parts({
        limits: { fileSize: MAX_VIDEO_FILE_SIZE_BYTES_BY_TYPE.long, files: MAX_VIDEOS_PER_BULK },
      })) {
        if (part.fieldname === 'payload' && part.type === 'field') {
          const payload = parseBulkUploadPayload(part.value as string)

          plan = payload.items.map((item) => ({
            seriesId: payload.seriesId,
            sourceId: item.sourceId,
            videoType: item.videoType,
            metadataRevisionId: item.metadataRevisionId,
            // El payload HTTP usa "score" (así lo conoce el frontend/shorts-intelligence) —
            // se traduce a "priority" acá, en el borde, para que el dominio de publishing no
            // conozca de dónde viene ese número ni cómo se llama en otro bounded context.
            priority: item.videoType === PublishedVideoType.Short ? item.score : null,
            platformOptions: item.platformOptions ?? null,
            videoSize: item.videoSize,
            longVideoTimestampSec: item.videoType === PublishedVideoType.Short ? item.longVideoTimestampSec ?? null : null,
            longVideoUrl: item.videoType === PublishedVideoType.Short ? item.longVideoUrl ?? null : null,
          }))
          session = await useCase.prepare({
            organizationId,
            timeZone: payload.timeZone,
            longVideoPublishDay: payload.longVideoPublishDay ? new Date(payload.longVideoPublishDay) : new Date(),
            items: plan,
          })
          // Los items saltados (ej. videoType=long en TikTok — ver BulkUploadVideoUseCase)
          // nunca esperan un archivo real, pero el frontend igual puede mandarlo (mismo
          // multipart que usa para YouTube): no se agregan a pendingSourceIds, así que su
          // ausencia no dispara el error de "falta archivo" al final del loop.
          for (const item of plan) {
            if (!session.isSkipped(item.sourceId)) pendingSourceIds.add(item.sourceId)
          }
          continue
        }

        if (part.type !== 'file') continue

        if (!plan || !session) {
          // Drena el archivo antes de abortar — @fastify/multipart espera que cada part de
          // tipo archivo se consuma (o se descarte explícitamente) para poder cerrar limpio
          // el resto del stream de la request entrante.
          part.file.resume()
          throw new InvalidRequestError('"payload" field must come before video files in the multipart body')
        }

        const item = plan.find((i) => videoFieldName(i.sourceId) === part.fieldname)
        if (!item) {
          part.file.resume()
          throw new InvalidRequestError(`unexpected file field "${part.fieldname}"`)
        }

        if (session.isSkipped(item.sourceId)) {
          // videoType=long en una plataforma que lo excluye (ver excludesLongVideos) — el
          // archivo se drena sin subir nada, nunca se crea registro para este sourceId.
          part.file.resume()
          results.push(session.skippedResult(item.sourceId))
          continue
        }

        // Se sube inmediatamente mientras part.file sigue siendo el stream activo del
        // multipart — @fastify/multipart solo mantiene vivo un archivo a la vez. El límite de
        // tamaño del parser es el más permisivo (long); acá se aplica el límite real del
        // videoType de este item específico, cortando el stream en cuanto lo excede.
        const maxBytesForType = MAX_VIDEO_FILE_SIZE_BYTES_BY_TYPE[item.videoType]
        const bounded = boundStreamSize(part.file, maxBytesForType, item.sourceId, this.logger)
        // Carrera explícita contra el streaming en sí: si `bounded.done` se rechaza (ej.
        // VideoFileTooLargeError), esa promesa gana la carrera y el error se propaga de
        // inmediato — nunca depende de que el consumidor del stream detecte y propague por su
        // cuenta el evento 'error' del stream destruido. Si `done` resuelve en cambio
        // (streaming exitoso), esa rama nunca resuelve (promesa que nunca se cumple) para no
        // interferir con el resultado real de uploadItem, que sigue siendo la única fuente de
        // verdad para el caso de éxito.
        //
        // `bounded.done` puede rechazar DESPUÉS de que uploadItem ya haya ganado la carrera
        // (son dos observadores independientes del mismo stream, sin garantía de orden) — sin
        // manejarlo, esa rejection tardía quedaría sin ningún handler escuchándola (unhandled
        // rejection, puede derribar el proceso). Se adjunta un no-op catch aparte, desacoplado
        // de la carrera, que absorbe cualquier rechazo tardío sin afectar el resultado ya
        // resuelto de `uploadItem`.
        bounded.done.catch(() => {})
        const streamFailure = bounded.done.then(() => new Promise<never>(() => {}))
        results.push(await Promise.race([session.uploadItem(item, item.videoSize, bounded.stream), streamFailure]))
        pendingSourceIds.delete(item.sourceId)
      }

      if (!plan) {
        throw new InvalidRequestError('missing "payload" field')
      }
      if (pendingSourceIds.size > 0) {
        throw new InvalidRequestError(
          `missing video file for sourceId(s): ${[...pendingSourceIds].join(', ')}`,
        )
      }

      return reply.status(200).send({ results })
    } catch (error) {
      this.logger.error({ organizationId, error: error instanceof Error ? error.message : error }, '[BulkUploadController] bulkUpload failed')
      // InvalidRequestError y VideoFileTooLargeError son los únicos que pueden ocurrir a mitad
      // del loop de items (fieldname inesperado o archivo demasiado grande) — si para entonces
      // ya se subieron items con éxito (y quedaron confirmados en BD vía markUploaded), esos
      // resultados no deben descartarse: el caller los necesita para saber qué sourceIds ya
      // están resueltos y cuáles reintentar.
      if (error instanceof InvalidRequestError) {
        return reply.status(results.length > 0 ? 207 : 400).send({ error: 'INVALID_PAYLOAD', message: error.message, results })
      }
      if (error instanceof TooManyVideosError) {
        return reply.status(400).send({ error: 'TOO_MANY_VIDEOS' })
      }
      if (error instanceof NoPlatformConnectionError) {
        return reply.status(409).send({ error: 'NO_PLATFORM_CONNECTION', message: error.message })
      }
      if (error instanceof VideoFileTooLargeError) {
        return reply.status(results.length > 0 ? 207 : 400).send({ error: 'VIDEO_FILE_TOO_LARGE', message: error.message, results })
      }
      if (error instanceof MetadataRevisionNotFoundError) {
        return reply.status(400).send({ error: 'METADATA_REVISION_NOT_FOUND' })
      }
      if (error instanceof MetadataRevisionSourceMismatchError) {
        return reply.status(400).send({ error: 'METADATA_REVISION_SOURCE_MISMATCH', message: error.message })
      }
      if (error instanceof ScheduleCapacityExceededError) {
        return reply.status(409).send({ error: 'SCHEDULE_CAPACITY_EXCEEDED' })
      }
      if (error instanceof ActiveUploadAlreadyExistsError) {
        // Reintentar un sourceId que ya tiene un registro activo (subido con éxito o en
        // curso) — el caller debe evitar reenviar sourceIds ya resueltos en un intento previo.
        return reply.status(409).send({ error: 'ACTIVE_UPLOAD_ALREADY_EXISTS', message: error.message })
      }
      if (error instanceof VideoUploadRejectedError) {
        // Plataforma rechazó las opciones pedidas (ej. TikTok: privacy_level fuera de las
        // opciones permitidas para una app no auditada) — no reintentar, el frontend cae al
        // fallback (ver GetTikTokPublishingCapabilitiesUseCase).
        return reply.status(409).send({ error: 'VIDEO_UPLOAD_REJECTED', message: error.message, results })
      }
      if (error instanceof VideoUploadQuotaExceededError) {
        return reply.status(429).send({ error: 'RATE_LIMITED', results })
      }
      if (error instanceof VideoUploadTokenExpiredError) {
        return reply.status(409).send({ error: 'PLATFORM_TOKEN_EXPIRED', results })
      }
      // PendingUploadNotFoundError y MetadataNotResolvedForUploadError no se mapean a un 4xx:
      // nunca deberían ocurrir (invariantes internas rotas, no datos de usuario inválidos) —
      // se dejan propagar como 500 real para alertar a monitoring en vez de disfrazarse de
      // error de validación del cliente.
      throw error
    }
  }
}
