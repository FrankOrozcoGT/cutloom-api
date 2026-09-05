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
    const parsed = data.parsed as {
      summary: string
      correctedSubtitles: { start: number; end: number; text: string }[]
    }
    return {
      summary: parsed.summary,
      correctedSubtitles: parsed.correctedSubtitles,
      usage: data.usage,
    }
  }

  async detectShorts(prompt: string): Promise<DetectShortsResult> {
    const data = await this.callWithRetry(prompt)
    const parsed = data.parsed as {
      shorts: { start: number; end: number; confidence: number; reason: string }[]
    }
    return { shorts: parsed.shorts, usage: data.usage }
  }

  async scoreShorts(prompt: string): Promise<ScoreShortsResult> {
    const data = await this.callWithRetry(prompt)
    const parsed = data.parsed as { scored: { start: number; end: number; score: number }[] }
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
