import { isRecord } from '../../domain/validation'
import type { Logger } from '../../domain/ports/Logger'

export interface DeepSeekConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export interface DeepSeekUsage {
  promptTokens: number
  completionTokens: number
}

export interface DeepSeekCallResult {
  /** JSON ya parseado desde el string de `choices[0].message.content` — el shape de negocio específico lo valida cada caller. */
  parsed: unknown
  usage: DeepSeekUsage
}

/** Fallo de red/HTTP contra DeepSeek — candidato real a retry (puede ser transitorio, ej. 503 bajo carga). */
export class DeepSeekTransientError extends Error {}

/** JSON malformado o shape inesperado — determinista para ese contenido exacto, reintentar el mismo prompt no cambia el resultado. */
export class DeepSeekMalformedResponseError extends Error {}

/** Contrato del request a /chat/completions — response_format y thinking son extensiones propias de DeepSeek sobre el formato compatible con OpenAI. */
interface DeepSeekChatRequest {
  model: string
  messages: { role: 'user'; content: string }[]
  response_format: { type: 'json_object' }
  /** Desactiva el modo de razonamiento extendido del modelo — sin esto, deepseek-v4-flash antepone una cadena de pensamiento al JSON final, multiplicando tokens y latencia sin aportar al resultado. */
  thinking: { type: 'disabled' }
}

/** Único punto de validación de forma para la respuesta HTTP cruda de DeepSeek (incluyendo usage) — de aquí en adelante el tipo se propaga sin recastear. */
function parseDeepSeekChatResponse(value: unknown): { content: string; usage: DeepSeekUsage } {
  if (
    !isRecord(value) ||
    !Array.isArray(value.choices) ||
    !isRecord(value.choices[0]) ||
    !isRecord(value.choices[0].message) ||
    typeof value.choices[0].message.content !== 'string' ||
    !isRecord(value.usage) ||
    typeof value.usage.prompt_tokens !== 'number' ||
    typeof value.usage.completion_tokens !== 'number'
  ) {
    throw new DeepSeekMalformedResponseError('DeepSeek chat response does not match the expected shape')
  }
  return {
    content: value.choices[0].message.content,
    usage: { promptTokens: value.usage.prompt_tokens, completionTokens: value.usage.completion_tokens },
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Cliente HTTP compartido para /chat/completions de DeepSeek — mecanismo idéntico entre
 * cualquier bounded context que consuma DeepSeek (shorts-intelligence, publishing): llamada
 * con timeout, un reintento ante fallo de red/HTTP (nunca ante JSON malformado, que es
 * determinista para ese contenido), y parseo de la envoltura de chat completions. El shape de
 * negocio específico de la respuesta (`parsed`) lo valida cada caller.
 */
export class DeepSeekChatClient {
  constructor(
    private readonly config: DeepSeekConfig,
    private readonly logger: Logger,
  ) {}

  async call(prompt: string): Promise<DeepSeekCallResult> {
    return this.callWithRetry(prompt)
  }

  private async callWithRetry(prompt: string): Promise<DeepSeekCallResult> {
    try {
      return await this.callOnce(prompt, 1)
    } catch (error) {
      // Solo se reintenta si el fallo fue de red/HTTP (potencialmente transitorio) — un JSON
      // malformado o respuesta vacía es determinista para ese contenido exacto del modelo;
      // reintentar el mismo prompt no cambia el resultado, solo duplica latencia y tokens.
      if (!(error instanceof DeepSeekTransientError)) {
        throw error
      }
      this.logger.info({}, '[DeepSeek] retrying after transient failure (attempt 2/2)')
      const result = await this.callOnce(prompt, 2)
      // Si este segundo intento tuvo éxito, el primero sí falló — dejarlo explícito en el
      // log de éxito evita que un blip transitorio de DeepSeek quede invisible solo porque
      // el request terminó bien: alguien revisando "¿por qué tardó tanto esta request?"
      // necesita ver esto sin tener que cruzar timestamps con el log de error de arriba.
      this.logger.info({}, '[DeepSeek] succeeded on retry after a prior transient failure')
      return result
    }
  }

  private async callOnce(prompt: string, attempt: 1 | 2): Promise<DeepSeekCallResult> {
    const httpStart = Date.now()
    this.logger.info({ attempt, promptLength: prompt.length }, '[DeepSeek] call starting')
    let res: Response
    try {
      res = await fetchWithTimeout(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
        } satisfies DeepSeekChatRequest),
      })
    } catch (error) {
      // fetch() en sí puede rechazar (no solo devolver !res.ok): timeout del AbortController,
      // socket reseteado por la red (ECONNRESET), DNS, etc. — todos son fallos de transporte,
      // igual de transitorios que un 5xx, así que cuentan para el mismo mecanismo de retry.
      const httpMs = Date.now() - httpStart
      this.logger.error({ attempt, httpMs, error }, '[DeepSeek] network call failed')
      throw new DeepSeekTransientError(
        `DeepSeek request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const httpMs = Date.now() - httpStart
    // fetch() ya resolvió acá — los headers de la respuesta llegaron. Si el proceso se cuelga
    // después de este punto, es leyendo/parseando el body (res.json()), no esperando la red.
    this.logger.info({ attempt, httpMs, status: res.status }, '[DeepSeek] HTTP response headers received')

    if (!res.ok) {
      this.logger.error({ attempt, httpMs }, '[DeepSeek] HTTP call failed')
      throw new DeepSeekTransientError(`DeepSeek request failed: ${await res.text()}`)
    }

    const bodyText = await this.readBodyWithChunkLogging(res, attempt)
    let rawBody: unknown
    try {
      rawBody = JSON.parse(bodyText)
    } catch {
      throw new DeepSeekMalformedResponseError('DeepSeek returned malformed JSON in the HTTP body')
    }
    const { content, usage } = parseDeepSeekChatResponse(rawBody)

    const parseStart = Date.now()
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new DeepSeekMalformedResponseError('DeepSeek returned malformed JSON')
    }
    const parseMs = Date.now() - parseStart

    this.logger.info(
      { httpMs, parseMs, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens },
      '[DeepSeek] call completed',
    )

    return { parsed, usage }
  }

  /**
   * Lee el body de la respuesta chunk por chunk (en vez de `res.json()`/`res.text()`, que no
   * dan ninguna visibilidad de progreso) — cada chunk recibido se logea con timestamp para
   * poder ver, en un cuelgue real, si el stream sigue entregando datos lentamente o si dejó de
   * recibir nada por completo después de un punto exacto.
   */
  private async readBodyWithChunkLogging(res: Response, attempt: 1 | 2): Promise<string> {
    const readStart = Date.now()
    if (!res.body) {
      this.logger.error({ attempt }, '[DeepSeek] response has no readable body stream')
      throw new DeepSeekMalformedResponseError('DeepSeek response has no body')
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let chunkCount = 0
    let totalBytes = 0

    while (true) {
      const result: { done: boolean; value: Uint8Array | undefined } = await reader.read()
      if (result.done || !result.value) break
      const value = result.value
      chunkCount += 1
      totalBytes += value.byteLength
      text += decoder.decode(value, { stream: true })
      this.logger.info(
        { attempt, chunkCount, chunkBytes: value.byteLength, totalBytes, elapsedMs: Date.now() - readStart },
        '[DeepSeek] body chunk received',
      )
    }

    this.logger.info(
      { attempt, chunkCount, totalBytes, readMs: Date.now() - readStart },
      '[DeepSeek] body stream finished',
    )
    return text
  }
}
