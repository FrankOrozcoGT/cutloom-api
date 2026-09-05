import type { AuthorizeFeatureUsageUseCase } from '../../../billing/application/use-cases/AuthorizeFeatureUsageUseCase'
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

export function buildShortsModule(db: Database, authorizeFeatureUsageUseCase: AuthorizeFeatureUsageUseCase): ShortsModule {
  const usageEventRepository = new DrizzleUsageEventRepository(db)

  const deepSeekProvider = new DeepSeekProvider({
    apiKey: readEnv('DEEPSEEK_API_KEY', process.env.NODE_ENV === 'production' ? undefined : 'sk-placeholder'),
    baseUrl: readEnv('DEEPSEEK_API_BASE_URL', 'https://api.deepseek.com'),
    model: readEnv('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
  })

  const senseVoiceProvider = new SenseVoiceProvider({
    modelPath: readEnv('SENSEVOICE_MODEL_PATH', '/opt/models/sense-voice/model.int8.onnx'),
    tokensPath: readEnv('SENSEVOICE_TOKENS_PATH', '/opt/models/sense-voice/tokens.txt'),
    maxConcurrency: Number(readEnv('SENSEVOICE_MAX_CONCURRENCY', '2')),
  })

  const subtitlePromptBuilder = new SubtitlePromptBuilder()
  const shortPromptBuilder = new ShortPromptBuilder()
  const shortScorePromptBuilder = new ShortScorePromptBuilder()
  const usageEventService = new UsageEventService(usageEventRepository)

  const improveSubtitlesUseCase = new ImproveSubtitlesUseCase(
    authorizeFeatureUsageUseCase,
    deepSeekProvider,
    subtitlePromptBuilder,
    usageEventService,
  )

  const detectShortsUseCase = new DetectShortsUseCase(
    authorizeFeatureUsageUseCase,
    deepSeekProvider,
    shortPromptBuilder,
    usageEventService,
  )

  const scoreShortsUseCase = new ScoreShortsUseCase(
    authorizeFeatureUsageUseCase,
    deepSeekProvider,
    senseVoiceProvider,
    shortScorePromptBuilder,
    usageEventService,
  )

  const controller = new ShortsController(improveSubtitlesUseCase, detectShortsUseCase, scoreShortsUseCase)

  return { controller, usageEventRepository }
}
