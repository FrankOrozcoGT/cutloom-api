import type { Database } from '../../../shared/infrastructure/db/client'
import { readEnv } from '../../../shared/infrastructure/config/readEnv'
import type { PublishingFeatureAuthorizer } from '../../domain/ports/PublishingFeatureAuthorizer'
import type { UsageEventRecorder } from '../../domain/ports/UsageEventRecorder'
import type { Logger } from '../../../shared/domain/ports/Logger'
import { VideoPlatform } from '../../domain/entities/PublishedVideo'
import { YouTubeOAuthProvider } from '../providers/YouTubeOAuthProvider'
import { TikTokOAuthProvider } from '../providers/TikTokOAuthProvider'
import { AesTokenEncryptionService } from '../services/AesTokenEncryptionService'
import type { PlatformOAuthTokenRepository } from '../../domain/ports/PlatformOAuthTokenRepository'
import type { PlatformAccountRepository } from '../../domain/ports/PlatformAccountRepository'
import type { ActivePlatformAccountRepository } from '../../domain/ports/ActivePlatformAccountRepository'
import { DrizzleContentRevisionRepository } from '../repositories/DrizzleContentRevisionRepository'
import { DeepSeekMetadataProvider } from '../providers/DeepSeekMetadataProvider'
import { renderPromptTemplate } from '../prompts/loadPromptTemplate'
import { YouTubeMetadataPromptBuilder } from '../../application/services/YouTubeMetadataPromptBuilder'
import { StartOAuthUseCase } from '../../application/use-cases/StartOAuthUseCase'
import { HandleOAuthCallbackUseCase } from '../../application/use-cases/HandleOAuthCallbackUseCase'
import { GenerateYouTubeMetadataUseCase } from '../../application/use-cases/GenerateYouTubeMetadataUseCase'
import { PlanBulkUploadUseCase } from '../../application/use-cases/PlanBulkUploadUseCase'
import { BulkUploadOrchestrator } from '../../application/use-cases/BulkUploadOrchestrator'
import { CancelBulkUploadService } from '../../application/services/CancelBulkUploadService'
import { CancelBulkUploadUseCase } from '../../application/use-cases/CancelBulkUploadUseCase'
import { GetBulkUploadStatusUseCase } from '../../application/use-cases/GetBulkUploadStatusUseCase'
import { ExpireStaleBulkUploadsUseCase } from '../../application/use-cases/ExpireStaleBulkUploadsUseCase'
import { PublishScheduledVideosUseCase } from '../../application/use-cases/PublishScheduledVideosUseCase'
import { ScheduleUploadPlanService } from '../../application/services/ScheduleUploadPlanService'
import { DrizzlePublishedVideoRepository } from '../repositories/DrizzlePublishedVideoRepository'
import { DrizzleBulkUploadRepository } from '../repositories/DrizzleBulkUploadRepository'
import { DrizzleSourceUploadRepository } from '../repositories/DrizzleSourceUploadRepository'
import { YouTubeDataApiUploader } from '../providers/YouTubeDataApiUploader'
import { TikTokContentPostingUploader } from '../providers/TikTokContentPostingUploader'
import { OAuthPlatformCredentialResolver } from '../services/OAuthPlatformCredentialResolver'
import { TusBulkUploadHandler } from '../http/TusBulkUploadHandler'
import { TusServerUploadCreator } from '../storage/TusServerUploadCreator'
import { TusS3SourceUploadBinaryReader } from '../storage/TusS3SourceUploadBinaryReader'
import { GetTikTokPublishingCapabilitiesUseCase } from '../../application/use-cases/GetTikTokPublishingCapabilitiesUseCase'
import { HandleTikTokWebhookUseCase } from '../../application/use-cases/HandleTikTokWebhookUseCase'
import { RetryFailedPublicationsUseCase } from '../../application/use-cases/RetryFailedPublicationsUseCase'
import { DeleteBinaryIfAllPlatformsResolvedService } from '../../application/services/DeleteBinaryIfAllPlatformsResolvedService'
import { ReconcileBulkUploadStatusService } from '../../application/services/ReconcileBulkUploadStatusService'
import { PublishPlatformVideoService } from '../../application/services/PublishPlatformVideoService'
import { PlatformOAuthController } from '../http/PlatformOAuthController'
import { PlanBulkUploadController } from '../http/PlanBulkUploadController'
import { GenerateMetadataController } from '../http/GenerateMetadataController'
import type { NotificationRepository } from '../../../shared/domain/ports/NotificationRepository'
import type { NotificationPublisher } from '../../../shared/domain/ports/NotificationPublisher'

export interface PublishingModule {
  oauthController: PlatformOAuthController
  planBulkUploadController: PlanBulkUploadController
  generateMetadataController: GenerateMetadataController
  tusBulkUploadHandler: TusBulkUploadHandler
  expireStaleBulkUploadsUseCase: ExpireStaleBulkUploadsUseCase
  publishScheduledTikTokVideosUseCase: PublishScheduledVideosUseCase
  handleTikTokWebhookUseCase: HandleTikTokWebhookUseCase
}

export function buildPublishingModule(
  db: Database,
  featureAuthorizer: PublishingFeatureAuthorizer,
  usageEventRecorder: UsageEventRecorder,
  logger: Logger,
  oauthTokenRepository: PlatformOAuthTokenRepository,
  platformAccountRepository: PlatformAccountRepository,
  activePlatformAccountRepository: ActivePlatformAccountRepository,
  notificationRepository: NotificationRepository,
  notificationPublisher: NotificationPublisher,
  apiBaseUrl: string,
): PublishingModule {
  // redirect_uri construido desde API_BASE_URL (único dominio base del backend) en vez de una
  // variable suelta por proveedor — evita que cambiar de ambiente (dev/túnel/prod) requiera
  // actualizar varios redirect_uri por separado y queden desincronizados entre sí (ver
  // GOOGLE_REDIRECT_URI/YOUTUBE_OAUTH_REDIRECT_URI/TIKTOK_OAUTH_REDIRECT_URI, eliminadas del .env).
  const youTubeOAuthProvider = new YouTubeOAuthProvider({
    clientId: readEnv('GOOGLE_CLIENT_ID'),
    clientSecret: readEnv('GOOGLE_CLIENT_SECRET'),
    redirectUri: `${apiBaseUrl}/api/publishing/youtube/auth/callback`,
  })
  const tikTokOAuthProvider = new TikTokOAuthProvider({
    clientKey: readEnv('TIKTOK_CLIENT_KEY', process.env.NODE_ENV === 'production' ? undefined : 'dev-placeholder'),
    clientSecret: readEnv('TIKTOK_CLIENT_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-placeholder'),
    redirectUri: `${apiBaseUrl}/api/publishing/tiktok/auth/callback`,
  })

  const encryptionService = new AesTokenEncryptionService(readEnv('PLATFORM_OAUTH_ENCRYPTION_KEY'))
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
  const generateYouTubeMetadataUseCase = new GenerateYouTubeMetadataUseCase(
    featureAuthorizer,
    deepSeekMetadataProvider,
    youTubeMetadataPromptBuilder,
    contentRevisionRepository,
    usageEventRecorder,
    logger,
  )

  // Un mismo StartOAuthUseCase/HandleOAuthCallbackUseCase por plataforma, sobre la tabla
  // compartida platform_oauth_tokens — el caso de uso en sí nunca conoce el nombre del
  // proveedor, solo recibe su propio PlatformOAuthPort.
  const startOAuthUseCaseByPlatform = {
    [VideoPlatform.YouTube]: new StartOAuthUseCase(youTubeOAuthProvider),
    [VideoPlatform.TikTok]: new StartOAuthUseCase(tikTokOAuthProvider),
  }
  const handleOAuthCallbackUseCaseByPlatform = {
    [VideoPlatform.YouTube]: new HandleOAuthCallbackUseCase(
      VideoPlatform.YouTube,
      youTubeOAuthProvider,
      platformAccountRepository,
      activePlatformAccountRepository,
      oauthTokenRepository,
      encryptionService,
    ),
    [VideoPlatform.TikTok]: new HandleOAuthCallbackUseCase(
      VideoPlatform.TikTok,
      tikTokOAuthProvider,
      platformAccountRepository,
      activePlatformAccountRepository,
      oauthTokenRepository,
      encryptionService,
    ),
  }

  const publishedVideoRepository = new DrizzlePublishedVideoRepository(db)
  const bulkUploadRepository = new DrizzleBulkUploadRepository(db)
  const sourceUploadRepository = new DrizzleSourceUploadRepository(db)
  const scheduleUploadPlanService = new ScheduleUploadPlanService()

  const youTubeCredentialResolver = new OAuthPlatformCredentialResolver(oauthTokenRepository, encryptionService, youTubeOAuthProvider)
  const tikTokCredentialResolver = new OAuthPlatformCredentialResolver(oauthTokenRepository, encryptionService, tikTokOAuthProvider)
  const credentialResolverByPlatform = {
    [VideoPlatform.YouTube]: youTubeCredentialResolver,
    [VideoPlatform.TikTok]: tikTokCredentialResolver,
  }

  const youTubeUploader = new YouTubeDataApiUploader()
  const tikTokUploader = new TikTokContentPostingUploader()
  const uploaderByPlatform = {
    [VideoPlatform.YouTube]: youTubeUploader,
    [VideoPlatform.TikTok]: tikTokUploader,
  }

  // YouTube: scheduling nativo vía status.publishAt. TikTok: la Content Posting API no lo
  // soporta — el binario queda en R2 y el cron (publishScheduledTikTokVideosUseCase) lo publica
  // al llegar publishAt (ver BulkUploadOrchestrator).
  const supportsNativeSchedulingByPlatform = {
    [VideoPlatform.YouTube]: true,
    [VideoPlatform.TikTok]: false,
  }

  // TusBulkUploadHandler no depende de BulkUploadOrchestrator (ni viceversa en su constructor):
  // se construye primero, el orchestrator usa su `store` para leer/borrar binarios, y los
  // eventos se conectan al final — evita la dependencia circular sin ningún hack de inyección
  // tardía (ver TusBulkUploadHandler.onActivity/onCompleted).
  const tusBulkUploadHandler = new TusBulkUploadHandler(
    {
      path: '/api/publishing/bulk-upload/files',
      bucket: readEnv('R2_SCHEDULED_VIDEOS_BUCKET', process.env.NODE_ENV === 'production' ? undefined : 'dev-placeholder'),
      accountId: readEnv('R2_ACCOUNT_ID', process.env.NODE_ENV === 'production' ? undefined : 'dev-placeholder'),
      accessKeyId: readEnv('R2_ACCESS_KEY_ID', process.env.NODE_ENV === 'production' ? undefined : 'dev-placeholder'),
      secretAccessKey: readEnv('R2_SECRET_ACCESS_KEY', process.env.NODE_ENV === 'production' ? undefined : 'dev-placeholder'),
    },
    logger,
  )

  const binaryReader = new TusS3SourceUploadBinaryReader(tusBulkUploadHandler.store)
  const deleteBinaryIfAllPlatformsResolved = new DeleteBinaryIfAllPlatformsResolvedService(
    publishedVideoRepository,
    sourceUploadRepository,
    binaryReader,
  )
  const reconcileBulkUploadStatus = new ReconcileBulkUploadStatusService(
    bulkUploadRepository,
    sourceUploadRepository,
    publishedVideoRepository,
  )
  const publishPlatformVideo = new PublishPlatformVideoService(
    sourceUploadRepository,
    binaryReader,
    publishedVideoRepository,
    contentRevisionRepository,
    credentialResolverByPlatform,
    uploaderByPlatform,
    supportsNativeSchedulingByPlatform,
    notificationRepository,
    notificationPublisher,
    deleteBinaryIfAllPlatformsResolved,
    reconcileBulkUploadStatus,
    logger,
  )

  const bulkUploadOrchestrator = new BulkUploadOrchestrator(
    bulkUploadRepository,
    sourceUploadRepository,
    publishedVideoRepository,
    supportsNativeSchedulingByPlatform,
    scheduleUploadPlanService,
    notificationRepository,
    notificationPublisher,
    publishPlatformVideo,
    reconcileBulkUploadStatus,
    logger,
  )

  tusBulkUploadHandler.onActivity((tusUploadId, now) => {
    bulkUploadOrchestrator.onSourceUploadActivity(tusUploadId, now).catch((error: unknown) => {
      logger.error({ tusUploadId, error }, '[publishingComposition] onSourceUploadActivity failed')
    })
  })
  tusBulkUploadHandler.onCompleted((tusUploadId) => {
    bulkUploadOrchestrator.onSourceUploadCompleted(tusUploadId).catch((error: unknown) => {
      logger.error({ tusUploadId, error }, '[publishingComposition] onSourceUploadCompleted failed')
    })
  })

  const tusUploadCreator = new TusServerUploadCreator(tusBulkUploadHandler.store, `${apiBaseUrl}/api/publishing/bulk-upload/files`)

  const planBulkUploadUseCase = new PlanBulkUploadUseCase(
    bulkUploadRepository,
    sourceUploadRepository,
    publishedVideoRepository,
    contentRevisionRepository,
    activePlatformAccountRepository,
    tusUploadCreator,
  )

  const getTikTokPublishingCapabilitiesUseCase = new GetTikTokPublishingCapabilitiesUseCase(
    activePlatformAccountRepository,
    Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET),
  )

  const oauthController = new PlatformOAuthController(
    startOAuthUseCaseByPlatform,
    handleOAuthCallbackUseCaseByPlatform,
    getTikTokPublishingCapabilitiesUseCase,
    readEnv('FRONTEND_URL'),
  )
  const cancelBulkUploadService = new CancelBulkUploadService(sourceUploadRepository, binaryReader, publishedVideoRepository, bulkUploadRepository)
  const cancelBulkUploadUseCase = new CancelBulkUploadUseCase(bulkUploadRepository, cancelBulkUploadService)
  const getBulkUploadStatusUseCase = new GetBulkUploadStatusUseCase(bulkUploadRepository, sourceUploadRepository, publishedVideoRepository)
  const retryFailedPublicationsUseCase = new RetryFailedPublicationsUseCase(bulkUploadRepository, bulkUploadOrchestrator)
  const planBulkUploadController = new PlanBulkUploadController(
    planBulkUploadUseCase,
    cancelBulkUploadUseCase,
    getBulkUploadStatusUseCase,
    retryFailedPublicationsUseCase,
    logger,
  )
  const generateMetadataController = new GenerateMetadataController(generateYouTubeMetadataUseCase, logger)

  const handleTikTokWebhookUseCase = new HandleTikTokWebhookUseCase(
    publishedVideoRepository,
    oauthTokenRepository,
    encryptionService,
    deleteBinaryIfAllPlatformsResolved,
    reconcileBulkUploadStatus,
    sourceUploadRepository,
    notificationRepository,
    notificationPublisher,
  )

  const expireStaleBulkUploadsUseCase = new ExpireStaleBulkUploadsUseCase(bulkUploadRepository, cancelBulkUploadService)

  // PublishScheduledVideosUseCase es genérico (cualquier plataforma sin scheduling nativo) —
  // hoy solo TikTok lo necesita, así que esta única instancia se nombra explícitamente por esa
  // plataforma. Si otra plataforma futura tampoco soporta scheduling nativo, se instancia una
  // vez más acá con su propio platform/credentialResolver/uploader, sin tocar la clase.
  const publishScheduledTikTokVideosUseCase = new PublishScheduledVideosUseCase(
    VideoPlatform.TikTok,
    publishedVideoRepository,
    publishPlatformVideo,
  )

  return {
    oauthController,
    planBulkUploadController,
    generateMetadataController,
    tusBulkUploadHandler,
    expireStaleBulkUploadsUseCase,
    publishScheduledTikTokVideosUseCase,
    handleTikTokWebhookUseCase,
  }
}
