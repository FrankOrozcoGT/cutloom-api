import type { GenerateMetadataResult, MetadataGenerator } from '../../domain/ports/MetadataGenerator'
import { InvalidYouTubeMetadataError, parseYouTubeMetadata } from '../../domain/entities/ContentRevision'
import type { Logger } from '../../../shared/domain/ports/Logger'
import { isRecord } from '../../../shared/domain/validation'

export interface DeepSeekConfig {
  apiKey: string
  baseUrl: string
  model: string
}

interface DeepSeekUsage {
  promptTokens: number
  completionTokens: number
}

/** Contrato del request a /chat/completions — response_format y thinking son extensiones propias de DeepSeek sobre el formato compatible con OpenAI. */
interface DeepSeekChatRequest {
  model: string
  messages: { role: 'user'; content: string }[]
  response_format: { type: 'json_object' }
  /** Desactiva el modo de razonamiento extendido del modelo — sin esto, deepseek-v4-flash antepone una cadena de pensamiento al JSON final, multiplicando tokens y latencia sin aportar al resultado. */
  thinking: { type: 'disabled' }
}

/** Fallo de red/HTTP contra DeepSeek — candidato real a retry (puede ser transitorio, ej. 503 bajo carga). */
class DeepSeekTransientError extends Error {}

/** JSON malformado o shape inesperado — determinista para ese contenido exacto, reintentar el mismo prompt no cambia el resultado. */
class DeepSeekMalformedResponseError extends Error {}

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

export class DeepSeekMetadataProvider implements MetadataGenerator {
  constructor(
    private readonly config: DeepSeekConfig,
    private readonly logger: Logger,
  ) {}

  async generate(prompt: string): Promise<GenerateMetadataResult> {
    const data = await this.callWithRetry(prompt)
    try {
      // parseYouTubeMetadata es el validador único de dominio (ver ContentRevision.ts),
      // compartido con DrizzleContentRevisionRepository — no se reintenta acá: shape
      // inválido es determinista para este contenido, ya se agotaron los retries de red.
      return { metadata: parseYouTubeMetadata(data.parsed), usage: data.usage }
    } catch (error) {
      if (error instanceof InvalidYouTubeMetadataError) {
        throw new DeepSeekMalformedResponseError('DeepSeek response does not match the expected YouTube metadata shape')
      }
      throw error
    }
  }

  private async callWithRetry(prompt: string): Promise<{ parsed: unknown; usage: DeepSeekUsage }> {
    try {
      return await this.call(prompt)
    } catch (error) {
      // Solo se reintenta si el fallo fue de red/HTTP (potencialmente transitorio) — un JSON
      // malformado o respuesta vacía es determinista para ese contenido exacto del modelo;
      // reintentar el mismo prompt no cambia el resultado, solo duplica latencia y tokens.
      if (!(error instanceof DeepSeekTransientError)) {
        throw error
      }
      return await this.call(prompt)
    }
  }

  private async call(prompt: string): Promise<{ parsed: unknown; usage: DeepSeekUsage }> {
    const httpStart = Date.now()
    const res = await fetchWithTimeout(`${this.config.baseUrl}/chat/completions`, {
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
    const httpMs = Date.now() - httpStart

    if (!res.ok) {
      this.logger.error({ httpMs }, '[DeepSeekMetadata] HTTP call failed')
      throw new DeepSeekTransientError(`DeepSeek request failed: ${await res.text()}`)
    }

    const rawBody: unknown = await res.json()
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
      '[DeepSeekMetadata] call completed',
    )

    return { parsed, usage }
  }
}
