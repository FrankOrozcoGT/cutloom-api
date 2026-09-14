import type { Readable } from 'node:stream'
import { pipeline, Transform } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { CookieSerializeOptions } from '@fastify/cookie'
import { isSafeReturnTo, buildOAuthCallbackUrl } from '../../../shared/infrastructure/http/oauthCallbackRedirect'
import type { StartYouTubeOAuthUseCase } from '../../application/use-cases/StartYouTubeOAuthUseCase'
import {
  HandleYouTubeOAuthCallbackUseCase,
  MissingAuthorizationCodeError,
  YouTubeConsentDeniedError,
  YouTubeOAuthProviderError,
} from '../../application/use-cases/HandleYouTubeOAuthCallbackUseCase'
import { YouTubeOAuthError } from '../providers/YouTubeOAuthProvider'
import { MissingTopicError, type GenerateYouTubeMetadataUseCase } from '../../application/use-cases/GenerateYouTubeMetadataUseCase'
import { FeatureAccessDeniedError } from '../../domain/ports/PublishingFeatureAuthorizer'
import type { VideoContext, VideoContextSubtitle } from '../../application/services/YouTubeMetadataPromptBuilder'
import { ScheduleCapacityExceededError } from '../../application/services/ScheduleUploadPlanService'
import {
  BulkUploadSession,
  BulkUploadToYouTubeUseCase,
  MAX_VIDEO_FILE_SIZE_BYTES_BY_TYPE,
  MAX_VIDEOS_PER_BULK,
  MetadataRevisionNotFoundError,
  MetadataRevisionSourceMismatchError,
  NoYouTubeConnectionError,
  TooManyVideosError,
  type BulkUploadItemResult,
  type BulkUploadPlanItem,
} from '../../application/use-cases/BulkUploadToYouTubeUseCase'
import { YouTubeVideoType } from '../../domain/entities/YouTubeVideo'
import { ActiveUploadAlreadyExistsError } from '../../domain/ports/YouTubeVideoRepository'
import type { Logger } from '../../../shared/domain/ports/Logger'
import { isRecord } from '../../../shared/domain/validation'

export class VideoFileTooLargeError extends Error {
  constructor(sourceId: string, videoType: YouTubeVideoType, maxBytes: number) {
    super(`Video file for sourceId "${sourceId}" (${videoType}) exceeds the ${maxBytes} bytes limit for that content type`)
    this.name = 'VideoFileTooLargeError'
  }
}

/** Error de validación de forma reutilizado por todos los parsers del archivo (bulk-upload, generate-metadata, auth/start, auth/callback) — no es exclusivo de bulk-upload pese al nombre histórico. */
export class InvalidRequestError extends Error {
  constructor(reason: string) {
    super(`Invalid request: ${reason}`)
    this.name = 'InvalidRequestError'
  }
}

interface BulkUploadPayloadLongItem {
  sourceId: string
  metadataRevisionId: string
  videoType: typeof YouTubeVideoType.Long
}

interface BulkUploadPayloadShortItem {
  sourceId: string
  metadataRevisionId: string
  videoType: typeof YouTubeVideoType.Short
  /** Score de shorts-intelligence (0-1) — obligatorio para shorts, decide el orden de calendarización. */
  score: number
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
  if (typeof value.sourceId !== 'string' || typeof value.metadataRevisionId !== 'string') return false

  if (value.videoType === YouTubeVideoType.Long) return true
  if (value.videoType === YouTubeVideoType.Short) return typeof value.score === 'number'
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
      '"payload.items" must be a non-empty array of {sourceId,metadataRevisionId,videoType,score?}',
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

interface YouTubeAuthCallbackQuery {
  code?: string
  state?: string
  error?: string
}

/** Único punto de validación de forma del querystring del callback OAuth — de aquí en adelante el tipo se propaga sin recastear. */
function parseYouTubeAuthCallbackQuery(value: unknown): YouTubeAuthCallbackQuery {
  if (!isRecord(value)) {
    throw new InvalidRequestError('OAuth callback querystring must be an object')
  }
  if (
    (value.code !== undefined && typeof value.code !== 'string') ||
    (value.state !== undefined && typeof value.state !== 'string') ||
    (value.error !== undefined && typeof value.error !== 'string')
  ) {
    throw new InvalidRequestError('OAuth callback querystring has malformed code/state/error')
  }
  return { code: value.code, state: value.state, error: value.error }
}

interface YouTubeAuthStartQuery {
  json?: string
  returnTo?: string
}

/** Único punto de validación de forma del querystring de auth/start — de aquí en adelante el tipo se propaga sin recastear. */
function parseYouTubeAuthStartQuery(value: unknown): YouTubeAuthStartQuery {
  if (!isRecord(value)) {
    throw new InvalidRequestError('auth/start querystring must be an object')
  }
  if (
    (value.json !== undefined && typeof value.json !== 'string') ||
    (value.returnTo !== undefined && typeof value.returnTo !== 'string')
  ) {
    throw new InvalidRequestError('auth/start querystring has malformed json/returnTo')
  }
  return { json: value.json, returnTo: value.returnTo }
}

function isVideoContextSubtitle(value: unknown): value is VideoContextSubtitle {
  return (
    isRecord(value) &&
    typeof value.start === 'number' &&
    typeof value.end === 'number' &&
    typeof value.text === 'string'
  )
}

function parseVideoContext(value: unknown): VideoContext {
  if (!isRecord(value)) {
    throw new InvalidRequestError('"context" must be an object')
  }

  const summary = value.summary
  if (summary !== undefined && typeof summary !== 'string') {
    throw new InvalidRequestError('"context.summary" must be a string')
  }

  const detectedReason = value.detectedReason
  if (detectedReason !== undefined && typeof detectedReason !== 'string') {
    throw new InvalidRequestError('"context.detectedReason" must be a string')
  }

  const score = value.score
  if (score !== undefined && typeof score !== 'number') {
    throw new InvalidRequestError('"context.score" must be a number')
  }

  const subtitles = value.subtitles
  if (subtitles !== undefined && (!Array.isArray(subtitles) || !subtitles.every(isVideoContextSubtitle))) {
    throw new InvalidRequestError('"context.subtitles" must be an array of {start,end,text}')
  }

  return { summary, detectedReason, score, subtitles }
}

interface GenerateMetadataBody {
  sourceId: string
  topic?: string
  tone?: string
  additionalInstructions?: string
  feedback?: string
  context?: VideoContext
}

/** Único punto de validación de forma del body de generateMetadata — de aquí en adelante el tipo se propaga sin recastear. */
function parseGenerateMetadataBody(value: unknown): GenerateMetadataBody {
  if (!isRecord(value) || typeof value.sourceId !== 'string') {
    throw new InvalidRequestError('"sourceId" is required')
  }
  if (
    (value.topic !== undefined && typeof value.topic !== 'string') ||
    (value.tone !== undefined && typeof value.tone !== 'string') ||
    (value.additionalInstructions !== undefined && typeof value.additionalInstructions !== 'string') ||
    (value.feedback !== undefined && typeof value.feedback !== 'string')
  ) {
    throw new InvalidRequestError('"topic", "tone", "additionalInstructions" and "feedback" must be strings')
  }
  return {
    sourceId: value.sourceId,
    topic: value.topic,
    tone: value.tone,
    additionalInstructions: value.additionalInstructions,
    feedback: value.feedback,
    context: value.context !== undefined ? parseVideoContext(value.context) : undefined,
  }
}

/** Fieldname que el frontend usa para el archivo de video de un item — ver contrato de POST /api/publishing/youtube/bulk-upload. */
function videoFieldName(sourceId: string): string {
  return `video_${sourceId}`
}

/**
 * @fastify/multipart solo permite un fileSize global por request (no distinto por archivo) —
 * este wrapper cuenta bytes en tiempo real y aborta con VideoFileTooLargeError en cuanto un
 * item específico (según su propio videoType) excede su límite real, sin esperar a que
 * termine de subirse un archivo entero que ya sabemos que va a exceder el límite.
 *
 * Se usa un Transform (no un PassThrough con listeners manuales de 'data'/'write') más
 * `pipeline()` para que Node maneje backpressure de forma nativa: si el consumidor final (la
 * subida a YouTube) lee más lento que el multipart entrante, `pipeline()` pausa la fuente
 * automáticamente en vez de acumular chunks sin techo en el buffer interno del stream — así
 * el video nunca se bufferiza completo en memoria, ni siquiera bajo diferencias de velocidad
 * sostenidas entre origen y destino.
 */
interface BoundStream {
  stream: Readable
  /**
   * Se resuelve cuando el pipeline termina bien, se rechaza con el error real (incluyendo
   * VideoFileTooLargeError) si falla. No hay que confiar en que el consumidor del stream
   * (gaxios/googleapis) detecte y propague correctamente el evento 'error' del stream — eso
   * depende de comportamiento interno de una librería de terceros no verificado. En cambio,
   * el caller debe correr la operación que consume `stream` en una carrera (Promise.race)
   * contra este `done`, así el error del stream siempre gana y nunca queda un request
   * colgado ni un upload silenciosamente truncado.
   */
  done: Promise<void>
}

function boundStreamSize(
  source: Readable,
  maxBytes: number,
  sourceId: string,
  videoType: YouTubeVideoType,
  logger: Logger,
): BoundStream {
  let bytesRead = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesRead += chunk.length
      if (bytesRead > maxBytes) {
        callback(new VideoFileTooLargeError(sourceId, videoType, maxBytes))
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
        logger.error({ sourceId, videoType, error: error.message }, '[PublishingController] boundStreamSize failed')
        reject(error)
        return
      }
      resolve()
    })
  })
  return { stream: counter, done }
}

const OAUTH_STATE_COOKIE = 'youtube_oauth_state'
const OAUTH_ORGANIZATION_COOKIE = 'youtube_oauth_organization_id'
const OAUTH_RETURN_TO_COOKIE = 'youtube_oauth_return_to'
const OAUTH_STATE_COOKIE_PATH = '/api/publishing/youtube/auth'

function stateCookieOptions(): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Google's redirect back is a top-level cross-site GET; 'strict' would drop the cookie.
    sameSite: 'lax' as const,
    path: OAUTH_STATE_COOKIE_PATH,
    maxAge: 60 * 10,
  }
}

export class PublishingController {
  constructor(
    private readonly startYouTubeOAuthUseCase: StartYouTubeOAuthUseCase,
    private readonly handleYouTubeOAuthCallbackUseCase: HandleYouTubeOAuthCallbackUseCase,
    private readonly generateYouTubeMetadataUseCase: GenerateYouTubeMetadataUseCase,
    private readonly bulkUploadToYouTubeUseCase: BulkUploadToYouTubeUseCase,
    private readonly logger: Logger,
    private readonly frontendUrl: string,
  ) {}

  async youtubeAuthStart(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    try {
      const { json, returnTo } = parseYouTubeAuthStartQuery(req.query)

      const state = crypto.randomUUID()
      reply.setCookie(OAUTH_STATE_COOKIE, state, stateCookieOptions())
      // El callback de Google es una navegación top-level del navegador (no lleva el header
      // Authorization) — por eso authMiddleware no puede aplicarse ahí. organizationId se
      // captura acá (donde sí hay Bearer token) y viaja en una cookie httpOnly junto al state.
      reply.setCookie(OAUTH_ORGANIZATION_COOKIE, req.organizationId, stateCookieOptions())

      // returnTo debe sobrevivir el roundtrip completo (start → Google → callback), igual que
      // state/organizationId — se valida acá con el mismo criterio que buildCallbackUrl usará
      // al reenviarlo, para no guardar en cookie algo que después se descartaría igual.
      if (returnTo && isSafeReturnTo(returnTo)) {
        reply.setCookie(OAUTH_RETURN_TO_COOKIE, returnTo, stateCookieOptions())
      }

      const url = this.startYouTubeOAuthUseCase.execute(state)

      // El header Location de una respuesta 302 no es legible desde fetch/XHR (limitación de
      // la spec, no configurable vía CORS) — si el caller es código del frontend (no una
      // navegación top-level del navegador), pide el JSON explícito para poder leer la URL y
      // navegar él mismo con window.location.assign(url).
      if (json === 'true') {
        return reply.status(200).send({ url })
      }

      return reply.redirect(url)
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        return reply.status(400).send({ error: 'INVALID_REQUEST', message: error.message })
      }
      throw error
    }
  }

  async youtubeAuthCallback(req: FastifyRequest, reply: FastifyReply) {
    // returnTo se lee de la cookie antes del try para que esté disponible en el catch-all
    // incluso si el parseo del querystring falla — sin esto, un query malformado perdería
    // el returnTo al redirigir con error, aunque la cookie sí lo tuviera.
    const returnTo = req.cookies[OAUTH_RETURN_TO_COOKIE]
    reply.clearCookie(OAUTH_STATE_COOKIE, stateCookieOptions())
    reply.clearCookie(OAUTH_ORGANIZATION_COOKIE, stateCookieOptions())
    reply.clearCookie(OAUTH_RETURN_TO_COOKIE, stateCookieOptions())

    try {
      const { code, state, error: googleError } = parseYouTubeAuthCallbackQuery(req.query)
      const expectedState = req.cookies[OAUTH_STATE_COOKIE]
      const organizationId = req.cookies[OAUTH_ORGANIZATION_COOKIE]

      if (!state || state !== expectedState || !organizationId) {
        return this.redirectWithError(reply, 'STATE_MISMATCH', returnTo)
      }

      await this.handleYouTubeOAuthCallbackUseCase.execute({
        organizationId,
        code,
        error: googleError,
      })
      return reply.redirect(this.buildCallbackUrl({ youtubeConnected: 'true' }, returnTo))
    } catch (error) {
      if (error instanceof YouTubeConsentDeniedError) {
        return this.redirectWithError(reply, 'CONSENT_DENIED', returnTo)
      }
      if (error instanceof YouTubeOAuthProviderError) {
        // Fallo real de Google (server_error, temporarily_unavailable, invalid_scope, etc.),
        // no un rechazo del usuario — se distingue del caso anterior para no mostrarle
        // "denegaste el permiso" cuando el problema es de infraestructura de Google.
        req.log.error(error, 'Google OAuth callback returned an error')
        return this.redirectWithError(reply, 'GOOGLE_OAUTH_ERROR', returnTo)
      }
      if (error instanceof MissingAuthorizationCodeError) {
        req.log.error(error, 'YouTube OAuth callback missing code with no Google error')
        return this.redirectWithError(reply, 'MISSING_AUTHORIZATION_CODE', returnTo)
      }
      if (error instanceof YouTubeOAuthError) {
        req.log.error(error, 'YouTube OAuth token exchange failed')
        return this.redirectWithError(reply, 'YOUTUBE_AUTH_FAILED', returnTo)
      }
      req.log.error(error, 'Unexpected error in YouTube OAuth callback')
      return this.redirectWithError(reply, 'UNEXPECTED_ERROR', returnTo)
    }
  }

  async generateMetadata(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    try {
      const { sourceId, topic, tone, additionalInstructions, feedback, context } = parseGenerateMetadataBody(req.body)
      const revision = await this.generateYouTubeMetadataUseCase.execute({
        organizationId: req.organizationId,
        sourceId,
        topic,
        tone,
        additionalInstructions,
        feedback,
        context,
      })
      return reply.status(200).send({
        revisionId: revision.id,
        version: revision.version,
        metadata: revision.metadata,
      })
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        return reply.status(400).send({ error: 'INVALID_REQUEST', message: error.message })
      }
      if (error instanceof FeatureAccessDeniedError) {
        return reply.status(403).send({ error: 'FEATURE_ACCESS_DENIED' })
      }
      if (error instanceof MissingTopicError) {
        return reply.status(400).send({ error: 'MISSING_TOPIC' })
      }
      throw error
    }
  }

  /**
   * multipart/form-data: el campo de texto "payload" (JSON con seriesId, timeZone,
   * longVideoPublishDay, e items: sourceId, metadataRevisionId, videoType, score opcional)
   * DEBE ir antes que los archivos de video en el multipart — cada archivo se streamea
   * directo a YouTube en cuanto llega (ver YouTubeDataApiUploader), así que necesitamos
   * conocer el plan completo antes del primer archivo. La calendarización (publishAt por
   * item) se calcula dentro de BulkUploadToYouTubeUseCase.prepare(), no acá — este
   * controller solo parsea el transporte HTTP. Un archivo por item, nombrado
   * "video_<sourceId>" (ver videoFieldName).
   */
  async bulkUpload(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }
    const organizationId = req.organizationId
    const results: BulkUploadItemResult[] = []

    try {
      let plan: BulkUploadPlanItem[] | undefined
      let session: BulkUploadSession | undefined
      const pendingSourceIds = new Set<string>()

      // El parser del multipart solo admite un fileSize global (no distinto por parte) — se
      // configura con el límite más permisivo (long) y cada archivo se valida contra el
      // límite real de su propio videoType (ver validateFileSizeByType) a medida que se
      // streamea, sin esperar a que termine de subir para descubrir que era demasiado grande.
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
            priority: item.videoType === YouTubeVideoType.Short ? item.score : null,
          }))
          session = await this.bulkUploadToYouTubeUseCase.prepare({
            organizationId,
            timeZone: payload.timeZone,
            longVideoPublishDay: payload.longVideoPublishDay ? new Date(payload.longVideoPublishDay) : new Date(),
            items: plan,
          })
          for (const item of plan) pendingSourceIds.add(item.sourceId)
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

        // Se sube inmediatamente mientras part.file sigue siendo el stream activo del
        // multipart — @fastify/multipart solo mantiene vivo un archivo a la vez. El límite de
        // tamaño del parser es el más permisivo (long); acá se aplica el límite real del
        // videoType de este item específico, cortando el stream en cuanto lo excede.
        const maxBytesForType = MAX_VIDEO_FILE_SIZE_BYTES_BY_TYPE[item.videoType]
        const bounded = boundStreamSize(part.file, maxBytesForType, item.sourceId, item.videoType, this.logger)
        // Carrera explícita contra el streaming en sí: si `bounded.done` se rechaza (ej.
        // VideoFileTooLargeError), esa promesa gana la carrera y el error se propaga de
        // inmediato — nunca depende de que gaxios/googleapis detecte y propague por su
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
        results.push(await Promise.race([session.uploadItem(item, bounded.stream), streamFailure]))
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
      // InvalidRequestError y VideoFileTooLargeError son los únicos que pueden ocurrir a mitad
      // del loop de items (fieldname inesperado o archivo demasiado grande) — si para entonces
      // ya se subieron items con éxito a YouTube (y quedaron confirmados en BD vía
      // markUploaded), esos resultados no deben descartarse: el caller los necesita para saber
      // qué sourceIds ya están resueltos y cuáles reintentar.
      if (error instanceof InvalidRequestError) {
        return reply.status(results.length > 0 ? 207 : 400).send({ error: 'INVALID_PAYLOAD', message: error.message, results })
      }
      if (error instanceof TooManyVideosError) {
        return reply.status(400).send({ error: 'TOO_MANY_VIDEOS' })
      }
      if (error instanceof NoYouTubeConnectionError) {
        return reply.status(409).send({ error: 'NO_YOUTUBE_CONNECTION' })
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
      // PendingUploadNotFoundError y MetadataNotResolvedForUploadError no se mapean a un 4xx:
      // nunca deberían ocurrir (invariantes internas rotas, no datos de usuario inválidos) —
      // se dejan propagar como 500 real para alertar a monitoring en vez de disfrazarse de
      // error de validación del cliente.
      throw error
    }
  }

  private buildCallbackUrl(params: Record<string, string>, returnTo: string | undefined): string {
    return buildOAuthCallbackUrl(this.frontendUrl, '/publishing/youtube/callback', params, returnTo)
  }

  private redirectWithError(reply: FastifyReply, error: string, returnTo?: string) {
    return reply.redirect(this.buildCallbackUrl({ error }, returnTo))
  }
}
