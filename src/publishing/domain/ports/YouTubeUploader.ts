import type { Readable } from 'node:stream'
import type { YouTubeMetadata } from '../entities/ContentRevision'

export interface UploadVideoInput {
  accessToken: string
  /** Stream del binario del video — nunca se bufferiza completo en memoria (ver YouTubeDataApiUploader). */
  videoStream: Readable
  metadata: YouTubeMetadata
  /** Si se especifica, el video se sube como "private" y YouTube lo hace público automáticamente en este instante (scheduling nativo). */
  publishAt: Date | null
}

export interface UploadVideoResult {
  youtubeVideoId: string
}

export class YouTubeUploadTokenExpiredError extends Error {
  constructor() {
    super('YouTube access token expired')
    this.name = 'YouTubeUploadTokenExpiredError'
  }
}

export class YouTubeUploadQuotaExceededError extends Error {
  constructor() {
    super('YouTube API quota exceeded')
    this.name = 'YouTubeUploadQuotaExceededError'
  }
}

export interface YouTubeUploader {
  upload(input: UploadVideoInput): Promise<UploadVideoResult>
}
