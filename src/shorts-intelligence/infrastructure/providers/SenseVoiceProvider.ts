import type { EmotionAnalysisResult, EmotionAnalyzerPort } from '../../domain/ports/EmotionAnalyzerPort'
import { SenseVoiceProcessManager } from './SenseVoiceProcessManager'

export interface SenseVoiceConfig {
  modelPath: string
  tokensPath: string
  workerEntryPath: string
  /** Kill-switch de operación real (ver .env SENSEVOICE_ENABLED) — si es false, analyze() falla de inmediato sin tocar el proceso hijo ni cargar el modelo. */
  enabled: boolean
  /** Límite de análisis concurrentes para no saturar CPU/memoria del droplet. */
  maxConcurrency: number
  /** Tras este tiempo sin trabajo, el proceso hijo de sherpa-onnx se mata para liberar su memoria. */
  idleTimeoutMs: number
  requestTimeoutMs: number
}

export class SenseVoiceDisabledError extends Error {
  constructor() {
    super('SenseVoice is disabled via SENSEVOICE_ENABLED=false')
    this.name = 'SenseVoiceDisabledError'
  }
}

/**
 * Ejecuta sherpa-onnx en un proceso hijo dedicado (ver SenseVoiceProcessManager
 * y sensevoiceWorkerEntry.ts) para poder liberar su memoria con garantía del
 * kernel tras inactividad, en vez de mantener el modelo cargado en el proceso
 * principal de por vida. Concurrencia limitada con un semáforo simple para no
 * saturar el droplet con múltiples análisis simultáneos.
 */
export class SenseVoiceProvider implements EmotionAnalyzerPort {
  private readonly processManager: SenseVoiceProcessManager
  private activeCount = 0
  private readonly queue: (() => void)[] = []

  constructor(private readonly config: SenseVoiceConfig) {
    this.processManager = new SenseVoiceProcessManager({
      modelPath: config.modelPath,
      tokensPath: config.tokensPath,
      workerEntryPath: config.workerEntryPath,
      idleTimeoutMs: config.idleTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
    })
  }

  async analyze(audioBuffer: Buffer): Promise<EmotionAnalysisResult> {
    if (!this.config.enabled) {
      throw new SenseVoiceDisabledError()
    }
    await this.acquireSlot()
    try {
      return await this.processManager.analyze(audioBuffer)
    } finally {
      this.releaseSlot()
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeCount < this.config.maxConcurrency) {
      this.activeCount++
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.activeCount++
  }

  private releaseSlot(): void {
    this.activeCount--
    const next = this.queue.shift()
    if (next) {
      next()
    }
  }
}
