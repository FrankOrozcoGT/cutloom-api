export interface SubtitleSegmentInput {
  start: number
  end: number
  text: string
}

export interface ImproveSubtitlesResult {
  summary: string
  correctedSubtitles: SubtitleSegmentInput[]
  usage: { promptTokens: number; completionTokens: number }
}

export interface ShortCandidate {
  start: number
  end: number
  confidence: number
  reason: string
}

export interface DetectShortsResult {
  shorts: ShortCandidate[]
  usage: { promptTokens: number; completionTokens: number }
}

export interface ScoredShortResult {
  start: number
  end: number
  score: number
}

export interface ScoreShortsResult {
  scored: ScoredShortResult[]
  usage: { promptTokens: number; completionTokens: number }
}

/** Puerto del LLM usado por shorts-intelligence (implementado por DeepSeekProvider). */
export interface ShortsIntelligencePort {
  improveSubtitles(prompt: string): Promise<ImproveSubtitlesResult>
  detectShorts(prompt: string): Promise<DetectShortsResult>
  scoreShorts(prompt: string): Promise<ScoreShortsResult>
}
