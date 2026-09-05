import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { EmotionAnalysisResult, EmotionAnalyzerPort } from '../../domain/ports/EmotionAnalyzerPort'

export interface SenseVoiceConfig {
  modelPath: string
  tokensPath: string
  /** Límite de análisis concurrentes para no saturar CPU/memoria del droplet — sherpa-onnx corre in-process. */
  maxConcurrency: number
}

// sherpa-onnx-node no publica tipos (paquete sin @types, confirmado al integrarlo) — se
// tipa aquí el único subconjunto de su API que este provider usa, siguiendo la firma real
// documentada en nodejs-addon-examples/test_asr_non_streaming_sense_voice.js del repo
// oficial. Este es el único punto del archivo que toca el SDK sin tipos; de aquí en
// adelante todo el código trabaja con estos tipos, no con `any`.
interface SherpaOnnxWave {
  sampleRate: number
  samples: Float32Array
}

interface SherpaOnnxOfflineStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
}

interface SherpaOnnxOfflineRecognizerResult {
  emotion?: string
}

interface SherpaOnnxOfflineRecognizer {
  createStream(): SherpaOnnxOfflineStream
  decode(stream: SherpaOnnxOfflineStream): void
  getResult(stream: SherpaOnnxOfflineStream): SherpaOnnxOfflineRecognizerResult
}

interface SherpaOnnxModule {
  OfflineRecognizer: new (config: {
    featConfig: { sampleRate: number; featureDim: number }
    modelConfig: {
      senseVoice: { model: string; useInverseTextNormalization: number }
      tokens: string
      numThreads: number
      provider: string
    }
  }) => SherpaOnnxOfflineRecognizer
  readWave(path: string): SherpaOnnxWave
}

const sherpa_onnx = createRequire(import.meta.url)('sherpa-onnx-node') as SherpaOnnxModule

function extractEmotionTag(rawEmotion: string): string {
  // SenseVoice expone la categoría como "<|HAPPY|>" — se normaliza a "HAPPY".
  const match = rawEmotion.match(/<\|(\w+)\|>/)
  return match?.[1] ?? rawEmotion
}

/**
 * Ejecuta sherpa-onnx (paquete `sherpa-onnx-node`) in-process contra el
 * modelo SenseVoice, siguiendo el ejemplo oficial del repo
 * (nodejs-addon-examples/test_asr_non_streaming_sense_voice.js) literalmente:
 * mismo featConfig/modelConfig y misma secuencia readWave -> createStream ->
 * acceptWaveform -> decode -> getResult. El audioBase64 recibido se escribe a
 * un WAV temporal porque `readWave` del paquete solo lee desde archivo.
 * Concurrencia limitada con un semáforo simple para no saturar el droplet.
 */
export class SenseVoiceProvider implements EmotionAnalyzerPort {
  private recognizer: SherpaOnnxOfflineRecognizer | undefined
  private activeCount = 0
  private readonly queue: (() => void)[] = []

  constructor(private readonly config: SenseVoiceConfig) {}

  // Carga perezosa: el modelo solo se necesita al primer análisis real. Instanciarlo
  // en el constructor rompería el arranque del servidor en cualquier entorno donde el
  // modelo/tokens aún no estén presentes en disco (ej. dev local sin el volumen del
  // droplet), aunque nadie use /api/shorts/score en ese momento.
  private getRecognizer(): SherpaOnnxOfflineRecognizer {
    if (!this.recognizer) {
      this.recognizer = new sherpa_onnx.OfflineRecognizer({
        featConfig: {
          sampleRate: 16000,
          featureDim: 80,
        },
        modelConfig: {
          senseVoice: {
            model: this.config.modelPath,
            useInverseTextNormalization: 1,
          },
          tokens: this.config.tokensPath,
          numThreads: 1,
          provider: 'cpu',
        },
      })
    }
    return this.recognizer
  }

  async analyze(audioBase64: string): Promise<EmotionAnalysisResult> {
    await this.acquireSlot()
    try {
      return await this.runRecognition(audioBase64)
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

  private async runRecognition(audioBase64: string): Promise<EmotionAnalysisResult> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'shorts-audio-'))
    const wavPath = join(tmpDir, `${randomUUID()}.wav`)
    try {
      await writeFile(wavPath, Buffer.from(audioBase64, 'base64'))

      const cpuStart = process.cpuUsage()
      const memBefore = process.memoryUsage().rss
      const wallStart = Date.now()

      const recognizer = this.getRecognizer()
      const stream = recognizer.createStream()
      const wave = sherpa_onnx.readWave(wavPath)
      stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
      recognizer.decode(stream)
      const result = recognizer.getResult(stream)

      const cpuDelta = process.cpuUsage(cpuStart)
      const memAfter = process.memoryUsage().rss
      const wallMs = Date.now() - wallStart
      console.error(
        `[SenseVoice] wallMs=${wallMs} cpuUserMs=${(cpuDelta.user / 1000).toFixed(1)} cpuSystemMs=${(cpuDelta.system / 1000).toFixed(1)} rssBeforeMB=${(memBefore / 1024 / 1024).toFixed(1)} rssAfterMB=${(memAfter / 1024 / 1024).toFixed(1)}`,
      )

      return { emotion: extractEmotionTag(result.emotion ?? '') }
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }
}
