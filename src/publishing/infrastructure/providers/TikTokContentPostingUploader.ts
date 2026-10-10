import type { Readable } from 'node:stream'
import { PublishedVideoStatus } from '../../domain/entities/PublishedVideo'
import type { UploadVideoInput, UploadVideoResult, VideoUploader } from '../../domain/ports/VideoUploader'
import { VideoUploadQuotaExceededError, VideoUploadRejectedError, VideoUploadTokenExpiredError } from '../../domain/ports/VideoUploader'
import { adaptMetadataForTikTok } from '../../application/services/adaptMetadataForTikTok'
import { isRecord } from '../../../shared/domain/validation'

const API_BASE = 'https://open.tiktokapis.com/v2/post/publish'
const CREATOR_INFO_ENDPOINT = `${API_BASE}/creator_info/query/`
const INIT_ENDPOINT = `${API_BASE}/video/init/`
const STATUS_ENDPOINT = `${API_BASE}/status/fetch/`

// Límites documentados de la Content Posting API (Media Transfer Guide): cada chunk entre
// 5MB y 64MB, salvo el último que puede absorber el remanente hasta 128MB. Un video < 5MB se
// sube entero en un único chunk del tamaño exacto del video.
const MIN_CHUNK_BYTES = 5 * 1024 * 1024
const MAX_CHUNK_BYTES = 64 * 1024 * 1024

interface TikTokPlatformOptions {
  privacyLevel: string | null
}

function readPlatformOptions(value: Record<string, unknown> | null): TikTokPlatformOptions {
  const privacyLevel = value && typeof value.privacyLevel === 'string' ? value.privacyLevel : null
  return { privacyLevel }
}

async function readErrorBody(response: Response): Promise<{ code: string | null; message: string | null }> {
  try {
    const body: unknown = await response.json()
    if (isRecord(body) && isRecord(body.error)) {
      return {
        code: typeof body.error.code === 'string' ? body.error.code : null,
        message: typeof body.error.message === 'string' ? body.error.message : null,
      }
    }
  } catch {
    // cuerpo no parseable como JSON — se reporta sin detalle adicional.
  }
  return { code: null, message: null }
}

/** true si el error es específicamente el de app no auditada — TikTok lo devuelve sin importar
 * post_mode (DIRECT_POST o MEDIA_UPLOAD) mientras privacy_level no sea SELF_ONLY (confirmado en
 * la práctica: creator_info/query devuelve las opciones de privacidad de la CUENTA, no el
 * límite de auditoría de la APP — una app sin auditar solo puede publicar SELF_ONLY sin importar
 * qué devuelva ese endpoint). TikTok no expone ningún endpoint de estado de auditoría
 * (confirmado contra la doc oficial y cómo lo resuelven terceros como Mixpost/Outstand): este
 * código de error, leído en el momento del intento real, es la única señal disponible. */
const UNAUDITED_CLIENT_ERROR_CODE = 'unaudited_client_can_only_post_to_private_accounts'
const SELF_ONLY_PRIVACY_LEVEL = 'SELF_ONLY'

class UnauditedClientError extends Error {
  constructor() {
    super(UNAUDITED_CLIENT_ERROR_CODE)
    this.name = 'UnauditedClientError'
  }
}

async function mapTikTokErrorResponse(response: Response): Promise<never> {
  const { code, message } = await readErrorBody(response)
  if (response.status === 401) throw new VideoUploadTokenExpiredError()
  if (response.status === 429 || code === 'spam_risk_too_many_posts' || code === 'rate_limit_exceeded') {
    throw new VideoUploadQuotaExceededError()
  }
  if (code === UNAUDITED_CLIENT_ERROR_CODE) {
    throw new UnauditedClientError()
  }
  if (code === 'privacy_level_option_mismatch') {
    throw new VideoUploadRejectedError(message ?? code)
  }
  throw new Error(message ?? `TikTok API request failed with status ${response.status}`)
}

interface CreatorInfo {
  privacyLevelOptions: string[]
  maxVideoPostDurationSec: number
}

function parseCreatorInfo(value: unknown): CreatorInfo {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new Error('creator_info/query response does not match the expected shape')
  }
  const data = value.data
  if (!Array.isArray(data.privacy_level_options) || typeof data.max_video_post_duration_sec !== 'number') {
    throw new Error('creator_info/query response does not match the expected shape')
  }
  return { privacyLevelOptions: data.privacy_level_options as string[], maxVideoPostDurationSec: data.max_video_post_duration_sec }
}

function parseInitResponse(value: unknown): { publishId: string; uploadUrl: string } {
  if (!isRecord(value) || !isRecord(value.data) || typeof value.data.publish_id !== 'string' || typeof value.data.upload_url !== 'string') {
    throw new Error('video/init response does not match the expected shape')
  }
  return { publishId: value.data.publish_id, uploadUrl: value.data.upload_url }
}

// Eventos de webhook de la Content Posting API — nombres actuales tras la migración desde el
// Video Kit deprecado (confirmado contra el bulletin oficial de TikTok for Developers,
// "Migration Notice for TikTok's Share Video API"): video.upload.failed -> post.publish.failed,
// video.publish.complete -> post.publish.complete, y el campo del payload pasó de share_id a
// publish_id (el mismo id que devuelve video/init/, no hace falta traducir nada).
export const TIKTOK_WEBHOOK_EVENT_PUBLISH_COMPLETE = 'post.publish.complete'
export const TIKTOK_WEBHOOK_EVENT_PUBLISH_FAILED = 'post.publish.failed'

export interface TikTokPostStatus {
  status: string
  failReason: string | null
  publiclyAvailablePostIds: string[]
}

function parseStatusResponse(value: unknown): TikTokPostStatus {
  if (!isRecord(value) || !isRecord(value.data) || typeof value.data.status !== 'string') {
    throw new Error('status/fetch response does not match the expected shape')
  }
  const data = value.data
  const status = data.status as string
  return {
    status,
    failReason: typeof data.fail_reason === 'string' ? data.fail_reason : null,
    publiclyAvailablePostIds: Array.isArray(data.publicaly_available_post_id)
      ? (data.publicaly_available_post_id as unknown[]).map(String)
      : [],
  }
}

/**
 * Única llamada puntual a status/fetch, disparada por el webhook (video.publish.completed /
 * video.upload.failed) — nunca en loop. El webhook solo trae el resultado final crudo
 * (share_id, sin fail_reason ni post_id numérico); esta consulta puntual completa el detalle
 * que el webhook no incluye.
 */
export async function fetchTikTokPostStatus(accessToken: string, publishId: string): Promise<TikTokPostStatus> {
  const response = await fetch(STATUS_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ publish_id: publishId }),
  })
  if (!response.ok) await mapTikTokErrorResponse(response)
  return parseStatusResponse(await response.json())
}

/**
 * Calcula el plan de chunking exigido por TikTok: chunk_size en [5MB, 64MB] y
 * total_chunk_count = floor(video_size / chunk_size) — floor, no ceil, para que el último
 * chunk absorba el remanente en vez de dejar un chunk final por debajo de 5MB, que TikTok
 * rechaza. Un video < 5MB va en un único chunk del tamaño exacto del video.
 */
function resolveChunkPlan(videoSize: number): { chunkSize: number; totalChunkCount: number } {
  if (videoSize <= MIN_CHUNK_BYTES) {
    return { chunkSize: videoSize, totalChunkCount: 1 }
  }
  const chunkSize = Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, videoSize))
  const totalChunkCount = Math.max(1, Math.floor(videoSize / chunkSize))
  return { chunkSize, totalChunkCount }
}

const CHUNK_UPLOAD_MAX_ATTEMPTS = 3

/** El fetch nativo de Bun/undici no reintenta un corte de socket a mitad de un PUT grande (visto
 * en la práctica con esta red: "The socket connection was closed unexpectedly" en una subida
 * lenta) — a diferencia del AWS SDK usado para R2 (ver TusBulkUploadHandler), que sí tiene su
 * propia lógica de retry configurable. Reintento manual acotado solo para este PUT puntual. */
async function putChunkWithRetry(uploadUrl: string, chunk: Buffer, offset: number, rangeEnd: number, videoSize: number): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= CHUNK_UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${offset}-${rangeEnd}/${videoSize}`,
          'Content-Length': String(chunk.length),
        },
        body: chunk,
      })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function readChunk(stream: Readable, size: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let collected = 0
  for await (const piece of stream as AsyncIterable<Buffer | string>) {
    const buf: Buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece)
    chunks.push(buf)
    collected += buf.length
    if (collected >= size) break
  }
  return Buffer.concat(chunks, Math.min(collected, size))
}

/**
 * Adaptador HTTP puro de la Content Posting API v2 — el único lugar del sistema que conoce el
 * nombre "TikTok" fuera del OAuth. No recibe publishAt: TikTok no soporta scheduling nativo,
 * así que BulkUploadVideoUseCase nunca lo invoca con un publishAt futuro (guarda el binario en
 * R2 en su lugar — ver PublishScheduledVideosUseCase).
 *
 * A diferencia de YouTube (síncrono: la llamada HTTP ya devuelve el resultado final), TikTok
 * resuelve el resultado de forma asíncrona — la API no expone ningún webhook ni endpoint de
 * status para el caso "borrador en bandeja" (confirmado contra la doc oficial: ningún evento
 * cubre SEND_TO_USER_INBOX), así que este adaptador NUNCA hace polling. upload() termina en
 * cuanto se suben los chunks, con status Uploading — la resolución final (publicado, borrador
 * completado por el usuario, o falló) llega exclusivamente vía el webhook
 * post.publish.complete / post.publish.failed, procesado por HandleTikTokWebhookUseCase.
 *
 * TikTok no expone ningún endpoint para saber de antemano si la app ya está auditada
 * (confirmado contra la doc oficial y cómo lo resuelven terceros como Mixpost/Outstand,
 * que tampoco tienen ese mecanismo) — así que este adaptador SIEMPRE intenta primero
 * DIRECT_POST (público). Si TikTok lo rechaza específicamente con
 * unaudited_client_can_only_post_to_private_accounts, reintenta automáticamente como
 * MEDIA_UPLOAD (borrador) en el mismo upload() — sin que ningún caller tenga que saber ni
 * decidir de antemano el estado de auditoría.
 */
export class TikTokContentPostingUploader implements VideoUploader {
  async upload(input: UploadVideoInput): Promise<UploadVideoResult> {
    try {
      return await this.attemptUpload(input, 'direct', null)
    } catch (error) {
      if (!(error instanceof UnauditedClientError)) throw error
      // El video/init de DIRECT_POST falla ANTES de subir ningún chunk (falla en el primer
      // request, el stream todavía no se tocó) — así que reintentar consumiendo el mismo
      // videoStream desde el inicio es seguro acá, a diferencia de un fallo a mitad de la
      // subida de chunks, donde el stream ya estaría parcialmente consumido. Una app sin
      // auditar solo puede publicar SELF_ONLY (ver UNAUDITED_CLIENT_ERROR_CODE) — eso aplica
      // igual en MEDIA_UPLOAD, por eso el reintento fuerza privacy_level acá, no solo post_mode.
      try {
        return await this.attemptUpload(input, 'inbox', SELF_ONLY_PRIVACY_LEVEL)
      } catch (inboxError) {
        const message = inboxError instanceof Error ? inboxError.message : String(inboxError)
        throw new Error(`direct attempt rejected as unaudited, inbox fallback also failed: ${message}`, { cause: inboxError })
      }
    }
  }

  private async attemptUpload(input: UploadVideoInput, postMode: 'direct' | 'inbox', forcedPrivacyLevel: string | null): Promise<UploadVideoResult> {
    const { privacyLevel: requestedPrivacyLevel } = readPlatformOptions(input.platformOptions)

    const creatorInfoResponse = await fetch(CREATOR_INFO_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
    })
    if (!creatorInfoResponse.ok) await mapTikTokErrorResponse(creatorInfoResponse)
    const creatorInfo = parseCreatorInfo(await creatorInfoResponse.json())

    const privacyLevel = forcedPrivacyLevel ?? requestedPrivacyLevel ?? creatorInfo.privacyLevelOptions[0]
    if (!privacyLevel || !creatorInfo.privacyLevelOptions.includes(privacyLevel)) {
      throw new VideoUploadRejectedError(
        `privacy_level "${privacyLevel}" is not among the options allowed for this app: ${creatorInfo.privacyLevelOptions.join(', ')}`,
      )
    }

    const tikTokMetadata = adaptMetadataForTikTok(input.metadata)
    const { chunkSize, totalChunkCount } = resolveChunkPlan(input.videoSize)

    const initBody = {
      post_info: {
        title: tikTokMetadata.title,
        privacy_level: privacyLevel,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: input.videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
      post_mode: postMode === 'direct' ? 'DIRECT_POST' : 'MEDIA_UPLOAD',
    }

    const initResponse = await fetch(INIT_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(initBody),
    })
    if (!initResponse.ok) await mapTikTokErrorResponse(initResponse)
    const { publishId, uploadUrl } = parseInitResponse(await initResponse.json())

    let offset = 0
    for (let chunkIndex = 0; chunkIndex < totalChunkCount; chunkIndex++) {
      const isLastChunk = chunkIndex === totalChunkCount - 1
      const thisChunkSize = isLastChunk ? input.videoSize - offset : chunkSize
      const chunk = await readChunk(input.videoStream, thisChunkSize)
      const rangeEnd = offset + chunk.length - 1

      const putResponse = await putChunkWithRetry(uploadUrl, chunk, offset, rangeEnd, input.videoSize)
      if (!putResponse.ok) {
        throw new Error(`Failed to upload chunk ${chunkIndex + 1}/${totalChunkCount} to TikTok`)
      }
      offset += chunk.length
    }

    // Sin polling: el resultado final llega por webhook (ver HandleTikTokWebhookUseCase). El
    // registro queda Publishing hasta que ese webhook lo resuelva. pendingManualAction=true en
    // inbox: ya sabemos con certeza que requiere que el usuario entre a TikTok a publicarlo —
    // se lo avisa el caller de inmediato (ver BulkUploadOrchestrator/PublishScheduledVideosUseCase),
    // sin esperar ninguna confirmación asíncrona para ese aviso puntual.
    return { publishId, status: PublishedVideoStatus.Publishing, platformVideoId: null, pendingManualAction: postMode === 'inbox' }
  }
}
