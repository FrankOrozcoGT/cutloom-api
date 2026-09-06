import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// sherpa-onnx-node no publica tipos (paquete sin @types, confirmado al integrarlo) — se
// tipa aquí el único subconjunto de su API que este worker usa, siguiendo la firma real
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

export interface SenseVoiceWorkerRequest {
  id: string
  modelPath: string
  tokensPath: string
  audioBase64: string
}

export interface SenseVoiceWorkerResponse {
  id: string
  emotion?: string
  error?: string
}

// SenseVoice puede devolver esta categoría cuando no logra clasificar la emoción con
// confianza suficiente (parámetro ban_emo_unk en false por defecto — confirmado real en
// logs, no es un error). Se trata como "sin emoción detectada" (undefined), igual que un
// fallo real de análisis, en vez de propagarla como si fuera una categoría emocional más.
const UNKNOWN_EMOTION_TAG = 'EMO_UNKNOWN'

function extractEmotionTag(rawEmotion: string): string | undefined {
  // SenseVoice expone la categoría como "<|HAPPY|>" — se normaliza a "HAPPY".
  const match = rawEmotion.match(/<\|(\w+)\|>/)
  const tag = match?.[1] ?? rawEmotion
  return tag === UNKNOWN_EMOTION_TAG ? undefined : tag
}

/**
 * Entry point del proceso hijo dedicado a sherpa-onnx (ver SenseVoiceProcessManager).
 * Corre como child_process.fork() real, no worker_thread — un bug crónico y sin
 * resolver de Node (nodejs/node#27998, #29784, #40878, #45685) hace que
 * worker_threads no siempre libere memoria de addons nativos al terminar. Un
 * proceso de SO real sí la libera con garantía del kernel al recibir SIGKILL,
 * sin depender de que el addon C++ se haya limpiado bien internamente.
 */
let recognizer: SherpaOnnxOfflineRecognizer | undefined
let sherpaOnnx: SherpaOnnxModule | undefined

function getRecognizer(modelPath: string, tokensPath: string): SherpaOnnxOfflineRecognizer {
  if (!sherpaOnnx) {
    sherpaOnnx = createRequire(import.meta.url)('sherpa-onnx-node') as SherpaOnnxModule
  }
  if (!recognizer) {
    recognizer = new sherpaOnnx.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: modelPath, useInverseTextNormalization: 1 },
        tokens: tokensPath,
        numThreads: 1,
        provider: 'cpu',
      },
    })
  }
  return recognizer
}

async function handleRequest(req: SenseVoiceWorkerRequest): Promise<SenseVoiceWorkerResponse> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'shorts-audio-'))
  const wavPath = join(tmpDir, `${randomUUID()}.wav`)
  try {
    await writeFile(wavPath, Buffer.from(req.audioBase64, 'base64'))

    const rec = getRecognizer(req.modelPath, req.tokensPath)
    const stream = rec.createStream()
    const wave = sherpaOnnx!.readWave(wavPath)
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
    rec.decode(stream)
    const result = rec.getResult(stream)

    console.error(`[SenseVoiceWorker] rawEmotion=${JSON.stringify(result.emotion)}`)
    return { id: req.id, emotion: extractEmotionTag(result.emotion ?? '') }
    // Nota: cuando extractEmotionTag devuelve undefined (EMO_UNKNOWN), el campo
    // "emotion" queda ausente de la respuesta — SenseVoiceProcessManager lo trata igual
    // que si no hubiera emoción detectada, ver su tipo SenseVoiceWorkerResponse.
  } catch (error) {
    return { id: req.id, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

process.on('message', (req: SenseVoiceWorkerRequest) => {
  void handleRequest(req).then((res) => {
    process.send?.(res)
  })
})
