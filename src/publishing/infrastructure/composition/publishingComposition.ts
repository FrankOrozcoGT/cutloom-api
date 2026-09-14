import type { Database } from '../../../shared/infrastructure/db/client'
import { readEnv } from '../../../shared/infrastructure/config/readEnv'
import type { PublishingFeatureAuthorizer } from '../../domain/ports/PublishingFeatureAuthorizer'
import type { Logger } from '../../../shared/domain/ports/Logger'
import { YouTubeOAuthProvider } from '../providers/YouTubeOAuthProvider'
import { AesTokenEncryptionService } from '../services/AesTokenEncryptionService'
import type { YouTubeOAuthTokenRepository } from '../../domain/ports/YouTubeOAuthTokenRepository'
import { DrizzleContentRevisionRepository } from '../repositories/DrizzleContentRevisionRepository'
import { DeepSeekMetadataProvider } from '../providers/DeepSeekMetadataProvider'
import { renderPromptTemplate } from '../prompts/loadPromptTemplate'
import { YouTubeMetadataPromptBuilder } from '../../application/services/YouTubeMetadataPromptBuilder'
import { StartYouTubeOAuthUseCase } from '../../application/use-cases/StartYouTubeOAuthUseCase'
import { HandleYouTubeOAuthCallbackUseCase } from '../../application/use-cases/HandleYouTubeOAuthCallbackUseCase'
import { GenerateYouTubeMetadataUseCase } from '../../application/use-cases/GenerateYouTubeMetadataUseCase'
import { BulkUploadToYouTubeUseCase } from '../../application/use-cases/BulkUploadToYouTubeUseCase'
import { ExpireStaleUploadingUseCase } from '../../application/use-cases/ExpireStaleUploadingUseCase'
import { ScheduleUploadPlanService } from '../../application/services/ScheduleUploadPlanService'
import { DrizzleYouTubeVideoRepository } from '../repositories/DrizzleYouTubeVideoRepository'
import { YouTubeDataApiUploader } from '../providers/YouTubeDataApiUploader'
import { PublishingController } from '../http/PublishingController'

export interface PublishingModule {
  controller: PublishingController
  expireStaleUploadingUseCase: ExpireStaleUploadingUseCase
}

export function buildPublishingModule(
  db: Database,
  featureAuthorizer: PublishingFeatureAuthorizer,
  logger: Logger,
  tokenRepository: YouTubeOAuthTokenRepository,
): PublishingModule {
  const youTubeOAuthProvider = new YouTubeOAuthProvider({
    clientId: readEnv('GOOGLE_CLIENT_ID'),
    clientSecret: readEnv('GOOGLE_CLIENT_SECRET'),
    // El fallback a localhost solo aplica en dev — en producción, sin esta env var, Google
    // rechazaría el intercambio de code por redirect_uri_mismatch de forma silenciosa (el
    // servidor arrancaría igual). Mismo patrón que DEEPSEEK_API_KEY abajo.
    redirectUri: readEnv(
      'YOUTUBE_OAUTH_REDIRECT_URI',
      process.env.NODE_ENV === 'production' ? undefined : 'http://localhost:3000/api/publishing/youtube/auth/callback',
    ),
  })

  const encryptionService = new AesTokenEncryptionService(readEnv('YOUTUBE_ENCRYPTION_KEY'))
  const contentRevisionRepository = new DrizzleContentRevisionRepository(db)

  const deepSeekMetadataProvider = new DeepSeekMetadataProvider(
    {
      apiKey: readEnv('DEEPSEEK_API_KEY', process.env.NODE_ENV === 'production' ? undefined : 'sk-placeholder'),
      baseUrl: readEnv('DEEPSEEK_API_BASE_URL', 'https://api.deepseek.com'),
      model: readEnv('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
    },
    logger,
  )
  const youTubeMetadataPromptBuilder = new YouTubeMetadataPromptBuilder(renderPromptTemplate)

  const startYouTubeOAuthUseCase = new StartYouTubeOAuthUseCase(youTubeOAuthProvider)
  const handleYouTubeOAuthCallbackUseCase = new HandleYouTubeOAuthCallbackUseCase(
    youTubeOAuthProvider,
    tokenRepository,
    encryptionService,
  )
  const generateYouTubeMetadataUseCase = new GenerateYouTubeMetadataUseCase(
    featureAuthorizer,
    deepSeekMetadataProvider,
    youTubeMetadataPromptBuilder,
    contentRevisionRepository,
    logger,
  )

  const youTubeVideoRepository = new DrizzleYouTubeVideoRepository(db)
  const youTubeUploader = new YouTubeDataApiUploader()
  const scheduleUploadPlanService = new ScheduleUploadPlanService()
  const bulkUploadToYouTubeUseCase = new BulkUploadToYouTubeUseCase(
    tokenRepository,
    encryptionService,
    youTubeOAuthProvider,
    contentRevisionRepository,
    youTubeUploader,
    youTubeVideoRepository,
    scheduleUploadPlanService,
  )

  const controller = new PublishingController(
    startYouTubeOAuthUseCase,
    handleYouTubeOAuthCallbackUseCase,
    generateYouTubeMetadataUseCase,
    bulkUploadToYouTubeUseCase,
    logger,
    readEnv('FRONTEND_URL'),
  )

  const expireStaleUploadingUseCase = new ExpireStaleUploadingUseCase(youTubeVideoRepository)

  return { controller, expireStaleUploadingUseCase }
}
