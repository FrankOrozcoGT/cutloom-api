import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { FeatureUsageAuthorizer } from '../../domain/ports/FeatureUsageAuthorizer'
import type { Database } from '../../../shared/infrastructure/db/client'
import { DeepSeekProvider } from '../providers/DeepSeekProvider'
import { SenseVoiceProvider } from '../providers/SenseVoiceProvider'
import { DrizzleUsageEventRepository } from '../repositories/DrizzleUsageEventRepository'
import { SubtitlePromptBuilder } from '../../application/services/SubtitlePromptBuilder'
import { ShortPromptBuilder } from '../../application/services/ShortPromptBuilder'
import { ShortScorePromptBuilder } from '../../application/services/ShortScorePromptBuilder'
import { UsageEventService } from '../../application/services/UsageEventService'
import { ImproveSubtitlesUseCase } from '../../application/use-cases/ImproveSubtitlesUseCase'
import { DetectShortsUseCase } from '../../application/use-cases/DetectShortsUseCase'
import { ScoreShortsUseCase } from '../../application/use-cases/ScoreShortsUseCase'
import { ShortsController } from '../http/ShortsController'
import type { UsageEventRepository } from '../../domain/ports/UsageEventRepository'

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export interface ShortsModule {
  controller: ShortsController
  usageEventRepository: UsageEventRepository
}

export function buildShortsModule(db: Database, featureUsageAuthorizer: FeatureUsageAuthorizer): ShortsModule {
  const usageEventRepository = new DrizzleUsageEventRepository(db)

  const deepSeekProvider = new DeepSeekProvider({
    apiKey: readEnv('DEEPSEEK_API_KEY', process.env.NODE_ENV === 'production' ? undefined : 'sk-placeholder'),
    baseUrl: readEnv('DEEPSEEK_API_BASE_URL', 'https://api.deepseek.com'),
    model: readEnv('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
  })

  const senseVoiceProvider = new SenseVoiceProvider({
    modelPath: readEnv('SENSEVOICE_MODEL_PATH', '/opt/models/sense-voice/model.int8.onnx'),
    tokensPath: readEnv('SENSEVOICE_TOKENS_PATH', '/opt/models/sense-voice/tokens.txt'),
    workerEntryPath: join(dirname(fileURLToPath(import.meta.url)), '..', 'providers', 'sensevoiceWorkerEntry.ts'),
    // Kill-switch real: default "true" para no cambiar el comportamiento existente,
    // pero permite desactivar SenseVoice por completo sin tocar código (ver .env).
    enabled: readEnv('SENSEVOICE_ENABLED', 'true') === 'true',
    maxConcurrency: Number(readEnv('SENSEVOICE_MAX_CONCURRENCY', '2')),
    // El proceso hijo se mata tras este tiempo sin trabajo para devolver su memoria
    // al sistema (~550-620MB medidos con el modelo cargado) — el droplet de dev/staging
    // solo tiene ~1GB disponible compartido con otros proyectos, ver deploy.prod.
    idleTimeoutMs: Number(readEnv('SENSEVOICE_IDLE_TIMEOUT_MS', String(5 * 60 * 1000))),
    requestTimeoutMs: Number(readEnv('SENSEVOICE_REQUEST_TIMEOUT_MS', String(30 * 1000))),
  })

  const subtitlePromptBuilder = new SubtitlePromptBuilder()
  const shortPromptBuilder = new ShortPromptBuilder()
  const shortScorePromptBuilder = new ShortScorePromptBuilder()
  const usageEventService = new UsageEventService(usageEventRepository)

  const improveSubtitlesUseCase = new ImproveSubtitlesUseCase(
    featureUsageAuthorizer,
    deepSeekProvider,
    subtitlePromptBuilder,
    usageEventService,
  )

  const detectShortsUseCase = new DetectShortsUseCase(
    featureUsageAuthorizer,
    deepSeekProvider,
    shortPromptBuilder,
    usageEventService,
  )

  const scoreShortsUseCase = new ScoreShortsUseCase(
    featureUsageAuthorizer,
    deepSeekProvider,
    senseVoiceProvider,
    shortScorePromptBuilder,
    usageEventService,
  )

  const controller = new ShortsController(improveSubtitlesUseCase, detectShortsUseCase, scoreShortsUseCase)

  return { controller, usageEventRepository }
}
