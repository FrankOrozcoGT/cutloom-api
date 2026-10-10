import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  PlanBulkUploadUseCase,
  MetadataRevisionNotFoundError,
  MetadataRevisionSourceMismatchError,
  TooManyVideosError,
  type PlanBulkUploadItem,
} from '../../application/use-cases/PlanBulkUploadUseCase'
import { CancelBulkUploadUseCase, BulkUploadNotFoundError } from '../../application/use-cases/CancelBulkUploadUseCase'
import { GetBulkUploadStatusUseCase } from '../../application/use-cases/GetBulkUploadStatusUseCase'
import { RetryFailedPublicationsUseCase, BulkUploadNotFoundByIdError } from '../../application/use-cases/RetryFailedPublicationsUseCase'
import { BulkUploadAlreadyActiveError } from '../../domain/ports/BulkUploadRepository'
import { ActiveUploadAlreadyExistsError } from '../../domain/ports/PublishedVideoRepository'
import { NoPlatformConnectionError } from '../../domain/ports/PlatformCredentialResolver'
import { PublishedVideoType, VideoPlatform } from '../../domain/entities/PublishedVideo'
import type { Logger } from '../../../shared/domain/ports/Logger'
import { isRecord } from '../../../shared/domain/validation'
import { InvalidRequestError, isVideoPlatform } from './httpValidation'

function isPlatformOptionsByPlatform(value: unknown): value is Partial<Record<VideoPlatform, Record<string, unknown> | null>> {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([platform, options]) => isVideoPlatform(platform) && (options === null || isRecord(options)))
}

function isPlanBulkUploadItem(value: unknown): value is PlanBulkUploadItem {
  if (!isRecord(value)) return false
  if (typeof value.sourceId !== 'string' || typeof value.videoSizeBytes !== 'number') return false
  if (value.videoType !== PublishedVideoType.Long && value.videoType !== PublishedVideoType.Short) return false
  if (typeof value.metadataRevisionId !== 'string') return false
  if (value.priority !== null && typeof value.priority !== 'number') return false
  if (value.longVideoTimestampSec !== null && typeof value.longVideoTimestampSec !== 'number') return false
  if (value.longVideoUrl !== null && typeof value.longVideoUrl !== 'string') return false
  if (!isPlatformOptionsByPlatform(value.platformOptionsByPlatform)) return false
  return true
}

/** Único punto de validación de forma del plan de un bulk — de aquí en adelante el tipo se propaga sin recastear. */
function parsePlanBulkUploadBody(value: unknown): {
  seriesId: string
  timeZone: string
  longVideoPublishDay: Date
  platforms: VideoPlatform[]
  items: PlanBulkUploadItem[]
} {
  if (!isRecord(value)) {
    throw new InvalidRequestError('body must be an object')
  }
  if (typeof value.seriesId !== 'string' || typeof value.timeZone !== 'string') {
    throw new InvalidRequestError('"seriesId" and "timeZone" are required strings')
  }
  // Opcional: el caso normal es "subir lo antes posible", sin elegir fecha — ScheduleUploadPlanService
  // ya corre hacia adelante desde el candidato hasta encontrar el primer hueco libre, así que
  // "ahora" como candidato produce exactamente ese comportamiento sin que el caller tenga que
  // mandar nada.
  if (value.longVideoPublishDay !== undefined && value.longVideoPublishDay !== null && typeof value.longVideoPublishDay !== 'string') {
    throw new InvalidRequestError('"longVideoPublishDay" must be a string when present')
  }
  const longVideoPublishDay = value.longVideoPublishDay ? new Date(value.longVideoPublishDay) : new Date()
  if (Number.isNaN(longVideoPublishDay.getTime())) {
    throw new InvalidRequestError('"longVideoPublishDay" must be a valid ISO date string')
  }
  if (!Array.isArray(value.platforms) || value.platforms.length === 0 || !value.platforms.every(isVideoPlatform)) {
    throw new InvalidRequestError('"platforms" must be a non-empty array of valid platforms')
  }
  if (!Array.isArray(value.items) || value.items.length === 0 || !value.items.every(isPlanBulkUploadItem)) {
    throw new InvalidRequestError(
      '"items" must be a non-empty array of {sourceId,videoType,metadataRevisionId,videoSizeBytes,priority,longVideoTimestampSec,longVideoUrl,platformOptionsByPlatform}',
    )
  }
  return {
    seriesId: value.seriesId,
    timeZone: value.timeZone,
    longVideoPublishDay,
    platforms: value.platforms,
    items: value.items,
  }
}

export class PlanBulkUploadController {
  constructor(
    private readonly planBulkUploadUseCase: PlanBulkUploadUseCase,
    private readonly cancelBulkUploadUseCase: CancelBulkUploadUseCase,
    private readonly getBulkUploadStatusUseCase: GetBulkUploadStatusUseCase,
    private readonly retryFailedPublicationsUseCase: RetryFailedPublicationsUseCase,
    private readonly logger: Logger,
  ) {}

  async planBulkUpload(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    try {
      const { seriesId, timeZone, longVideoPublishDay, platforms, items } = parsePlanBulkUploadBody(req.body)
      const result = await this.planBulkUploadUseCase.execute({
        organizationId: req.organizationId,
        seriesId,
        timeZone,
        longVideoPublishDay,
        platforms,
        items,
      })
      return reply.status(200).send(result)
    } catch (error) {
      this.logger.error(
        { organizationId: req.organizationId, error: error instanceof Error ? error.message : error },
        '[planBulkUpload] failed',
      )
      if (error instanceof InvalidRequestError) {
        return reply.status(400).send({ error: 'INVALID_REQUEST', message: error.message })
      }
      if (error instanceof TooManyVideosError) {
        return reply.status(400).send({ error: 'TOO_MANY_VIDEOS' })
      }
      if (error instanceof MetadataRevisionNotFoundError) {
        return reply.status(400).send({ error: 'METADATA_REVISION_NOT_FOUND' })
      }
      if (error instanceof MetadataRevisionSourceMismatchError) {
        return reply.status(400).send({ error: 'METADATA_REVISION_SOURCE_MISMATCH', message: error.message })
      }
      if (error instanceof NoPlatformConnectionError) {
        return reply.status(409).send({ error: 'NO_PLATFORM_CONNECTION', message: error.message })
      }
      if (error instanceof BulkUploadAlreadyActiveError) {
        return reply.status(409).send({ error: 'BULK_UPLOAD_ALREADY_ACTIVE', message: error.message })
      }
      if (error instanceof ActiveUploadAlreadyExistsError) {
        // sourceId ya resuelto en un bulk distinto (completado o aun en curso en OTRA serie) —
        // no es "seguir subiendo este bulk" (eso ya lo resuelve planBulkUpload reusando el
        // SourceUpload existente dentro del MISMO bulk), es un sourceId que el caller no debería
        // haber vuelto a mandar.
        return reply.status(409).send({ error: 'SOURCE_ID_ALREADY_PUBLISHED', message: error.message })
      }
      throw error
    }
  }

  /** Cancelación explícita a pedido del frontend — nunca disparada por el backend salvo el cron de expiración de 7 días (ExpireStaleBulkUploadsUseCase). */
  async cancelBulkUpload(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }
    const { seriesId } = req.params as { seriesId: string }

    try {
      await this.cancelBulkUploadUseCase.execute(req.organizationId, seriesId)
      return reply.status(204).send()
    } catch (error) {
      if (error instanceof BulkUploadNotFoundError) {
        return reply.status(404).send({ error: 'BULK_UPLOAD_NOT_FOUND', message: error.message })
      }
      this.logger.error(
        { organizationId: req.organizationId, seriesId, error: error instanceof Error ? error.message : error },
        '[cancelBulkUpload] failed',
      )
      throw error
    }
  }

  /** Estado real del bulk + cada archivo — el frontend decide con esto si continuar (reenviar el mismo plan) o cancelar y empezar de nuevo. */
  async getBulkUploadStatus(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }
    const { seriesId } = req.params as { seriesId: string }

    try {
      const result = await this.getBulkUploadStatusUseCase.execute(req.organizationId, seriesId)
      return reply.status(200).send(result)
    } catch (error) {
      if (error instanceof BulkUploadNotFoundError) {
        return reply.status(404).send({ error: 'BULK_UPLOAD_NOT_FOUND', message: error.message })
      }
      this.logger.error(
        { organizationId: req.organizationId, seriesId, error: error instanceof Error ? error.message : error },
        '[getBulkUploadStatus] failed',
      )
      throw error
    }
  }

  /** A pedido explícito del frontend desde la vista de un bulk — reintenta todo PublishedVideo Failed de ese bulk, por la plataforma en la que cada uno falló. */
  async retryFailedPublications(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }
    const { bulkUploadId } = req.params as { bulkUploadId: string }

    try {
      await this.retryFailedPublicationsUseCase.execute(req.organizationId, bulkUploadId)
      return reply.status(204).send()
    } catch (error) {
      if (error instanceof BulkUploadNotFoundByIdError) {
        return reply.status(404).send({ error: 'BULK_UPLOAD_NOT_FOUND', message: error.message })
      }
      this.logger.error(
        { organizationId: req.organizationId, bulkUploadId, error: error instanceof Error ? error.message : error },
        '[retryFailedPublications] failed',
      )
      throw error
    }
  }
}
