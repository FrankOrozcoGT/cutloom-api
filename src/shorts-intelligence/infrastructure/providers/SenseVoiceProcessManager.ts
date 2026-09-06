import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { SenseVoiceWorkerRequest, SenseVoiceWorkerResponse } from './sensevoiceWorkerEntry'

export interface SenseVoiceProcessManagerConfig {
  modelPath: string
  tokensPath: string
  workerEntryPath: string
  /** Tras este tiempo sin trabajo, el proceso hijo se mata (SIGKILL) para liberar toda su memoria — ver sensevoiceWorkerEntry.ts. */
  idleTimeoutMs: number
  requestTimeoutMs: number
}

/**
 * Administra el ciclo de vida del proceso hijo dedicado a sherpa-onnx: lo
 * levanta perezosamente en el primer análisis, lo reutiliza mientras haya
 * trabajo, y lo mata tras idleTimeoutMs de inactividad para devolver su
 * memoria al sistema (ver sensevoiceWorkerEntry.ts para el motivo de usar
 * child_process en vez de worker_threads).
 */
export class SenseVoiceProcessManager {
  private child: ChildProcess | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly pending = new Map<string, { resolve: (v: SenseVoiceWorkerResponse) => void; reject: (e: Error) => void }>()

  constructor(private readonly config: SenseVoiceProcessManagerConfig) {}

  async analyze(audioBuffer: Buffer): Promise<{ emotion: string | undefined }> {
    this.clearIdleTimer()
    const child = this.getChild()
    const id = randomUUID()

    const request: SenseVoiceWorkerRequest = {
      id,
      modelPath: this.config.modelPath,
      tokensPath: this.config.tokensPath,
      audioBase64: audioBuffer.toString('base64'),
    }

    try {
      const response = await this.sendRequest(child, request)
      if (response.error) {
        throw new Error(`SenseVoice worker error: ${response.error}`)
      }
      return { emotion: response.emotion }
    } finally {
      this.scheduleIdleShutdown()
    }
  }

  private getChild(): ChildProcess {
    if (this.child) {
      return this.child
    }

    const child = fork(this.config.workerEntryPath, { serialization: 'json' })
    child.on('message', (res: SenseVoiceWorkerResponse) => {
      const waiter = this.pending.get(res.id)
      if (waiter) {
        this.pending.delete(res.id)
        waiter.resolve(res)
      }
    })
    child.on('exit', () => {
      // El proceso puede morir por SIGKILL nuestro (idle) o por un crash real —
      // en ambos casos cualquier request en vuelo debe fallar, no quedar colgada.
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error('SenseVoice worker process exited before responding'))
      }
      this.pending.clear()
      if (this.child === child) {
        this.child = undefined
      }
    })

    this.child = child
    return child
  }

  private sendRequest(child: ChildProcess, request: SenseVoiceWorkerRequest): Promise<SenseVoiceWorkerResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.id)
        reject(new Error(`SenseVoice worker did not respond within ${this.config.requestTimeoutMs}ms`))
      }, this.config.requestTimeoutMs)

      this.pending.set(request.id, {
        resolve: (res) => {
          clearTimeout(timeout)
          resolve(res)
        },
        reject: (err) => {
          clearTimeout(timeout)
          reject(err)
        },
      })

      child.send(request)
    })
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      // SIGKILL, no SIGTERM: queremos la garantía dura del kernel liberando toda
      // la memoria del proceso de inmediato, no darle chance a un shutdown lento.
      this.child?.kill('SIGKILL')
      this.child = undefined
    }, this.config.idleTimeoutMs)
    // No debe mantener vivo el proceso principal solo por este timer.
    this.idleTimer.unref()
  }
}
