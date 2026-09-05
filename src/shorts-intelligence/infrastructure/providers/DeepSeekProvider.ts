import type {
  DetectShortsResult,
  ImproveSubtitlesResult,
  ScoreShortsResult,
  ShortsIntelligencePort,
} from '../../domain/ports/ShortsIntelligencePort'

export interface DeepSeekConfig {
  apiKey: string
  baseUrl: string
  model: string
}

interface DeepSeekChatResponse {
  choices: { message: { content: string } }[]
  usage: { prompt_tokens: number; completion_tokens: number }
}

interface ImproveSubtitlesShape {
  summary: string
  correctedSubtitles: { start: number; end: number; text: string }[]
}

interface DetectShortsShape {
  shorts: { start: number; end: number; confidence: number; reason: string }[]
}

interface ScoreShortsShape {
  scored: { start: number; end: number; score: number }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Único punto de validación de forma para respuestas del LLM — de aquí en adelante el tipo se propaga sin recastear. */
function parseImproveSubtitlesShape(value: unknown): ImproveSubtitlesShape {
  if (
    !isRecord(value) ||
    typeof value.summary !== 'string' ||
    !Array.isArray(value.correctedSubtitles) ||
    !value.correctedSubtitles.every(
      (s) => isRecord(s) && typeof s.start === 'number' && typeof s.end === 'number' && typeof s.text === 'string',
    )
  ) {
    throw new Error('DeepSeek response does not match the expected improveSubtitles shape')
  }
  return value as unknown as ImproveSubtitlesShape
}

function parseDetectShortsShape(value: unknown): DetectShortsShape {
  if (
    !isRecord(value) ||
    !Array.isArray(value.shorts) ||
    !value.shorts.every(
      (s) =>
        isRecord(s) &&
        typeof s.start === 'number' &&
        typeof s.end === 'number' &&
        typeof s.confidence === 'number' &&
        typeof s.reason === 'string',
    )
  ) {
    throw new Error('DeepSeek response does not match the expected detectShorts shape')
  }
  return value as unknown as DetectShortsShape
}

function parseScoreShortsShape(value: unknown): ScoreShortsShape {
  if (
    !isRecord(value) ||
    !Array.isArray(value.scored) ||
    !value.scored.every(
      (s) => isRecord(s) && typeof s.start === 'number' && typeof s.end === 'number' && typeof s.score === 'number',
    )
  ) {
    throw new Error('DeepSeek response does not match the expected scoreShorts shape')
  }
  return value as unknown as ScoreShortsShape
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

export class DeepSeekProvider implements ShortsIntelligencePort {
  constructor(private readonly config: DeepSeekConfig) {}

  async improveSubtitles(prompt: string): Promise<ImproveSubtitlesResult> {
    const data = await this.callWithRetry(prompt)
    const parsed = parseImproveSubtitlesShape(data.parsed)
    return {
      summary: parsed.summary,
      correctedSubtitles: parsed.correctedSubtitles,
      usage: data.usage,
    }
  }

  async detectShorts(prompt: string): Promise<DetectShortsResult> {
    const data = await this.callWithRetry(prompt)
    const parsed = parseDetectShortsShape(data.parsed)
    return { shorts: parsed.shorts, usage: data.usage }
  }

  async scoreShorts(prompt: string): Promise<ScoreShortsResult> {
    const data = await this.callWithRetry(prompt)
    const parsed = parseScoreShortsShape(data.parsed)
    return { scored: parsed.scored, usage: data.usage }
  }

  private async callWithRetry(
    prompt: string,
  ): Promise<{ parsed: unknown; usage: { promptTokens: number; completionTokens: number } }> {
    try {
      return await this.call(prompt)
    } catch {
      return await this.call(prompt)
    }
  }

  private async call(
    prompt: string,
  ): Promise<{ parsed: unknown; usage: { promptTokens: number; completionTokens: number } }> {
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
        // thinking está "enabled" por defecto en deepseek-v4-flash — sin desactivarlo,
        // el modelo genera una cadena de razonamiento interna antes del JSON final,
        // multiplicando tokens y tiempo de respuesta sin aportar nada a este caso de uso.
        thinking: { type: 'disabled' },
      }),
    })
    const httpMs = Date.now() - httpStart

    if (!res.ok) {
      console.error(`[DeepSeek] HTTP call failed after ${httpMs}ms`)
      throw new Error(`DeepSeek request failed: ${await res.text()}`)
    }

    const data = (await res.json()) as DeepSeekChatResponse
    const content = data.choices[0]?.message.content
    if (!content) {
      throw new Error('DeepSeek response missing content')
    }

    const parseStart = Date.now()
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      throw new Error('DeepSeek returned malformed JSON', { cause: error })
    }
    const parseMs = Date.now() - parseStart

    console.error(
      `[DeepSeek] httpCallMs=${httpMs} localParseMs=${parseMs} promptTokens=${data.usage.prompt_tokens} completionTokens=${data.usage.completion_tokens}`,
    )

    return {
      parsed,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
      },
    }
  }
}
