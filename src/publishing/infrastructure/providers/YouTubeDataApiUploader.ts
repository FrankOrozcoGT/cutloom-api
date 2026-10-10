import { google } from 'googleapis'
import { GaxiosError } from 'gaxios'
import { PublishedVideoStatus } from '../../domain/entities/PublishedVideo'
import type { UploadVideoInput, UploadVideoResult, VideoUploader } from '../../domain/ports/VideoUploader'
import { VideoUploadQuotaExceededError, VideoUploadTokenExpiredError } from '../../domain/ports/VideoUploader'

/**
 * Usa el cliente oficial de Google (googleapis) en vez de armar el protocolo resumable a
 * mano: media.body acepta un Readable stream, así que el video nunca se bufferiza completo
 * en memoria — viaja en streaming desde el multipart entrante hasta YouTube.
 */
export class YouTubeDataApiUploader implements VideoUploader {
  async upload(input: UploadVideoInput): Promise<UploadVideoResult> {
    const auth = new google.auth.OAuth2()
    auth.setCredentials({ access_token: input.accessToken })
    const youtube = google.youtube({ version: 'v3', auth })

    // publishAt solo es válido si privacyStatus es "private" — YouTube lo publica
    // automáticamente en ese instante (scheduling nativo), ver videos.insert docs.
    const status = input.publishAt
      ? { privacyStatus: 'private' as const, publishAt: input.publishAt.toISOString() }
      : { privacyStatus: 'public' as const }

    try {
      const res = await youtube.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title: input.metadata.title,
            description: input.metadata.description,
            tags: input.metadata.tags,
            categoryId: input.metadata.categoryId,
          },
          status,
        },
        media: {
          mimeType: 'video/*',
          body: input.videoStream,
        },
      })

      const youtubeVideoId = res.data.id
      if (!youtubeVideoId) {
        throw new Error('YouTube video upload response missing id')
      }
      return {
        platformVideoId: youtubeVideoId,
        status: input.publishAt ? PublishedVideoStatus.Scheduled : PublishedVideoStatus.Uploaded,
        publishId: null,
        pendingManualAction: false,
      }
    } catch (error) {
      if (error instanceof GaxiosError) {
        if (error.status === 401) {
          throw new VideoUploadTokenExpiredError()
        }
        if (error.status === 403 || error.status === 429) {
          throw new VideoUploadQuotaExceededError()
        }
      }
      throw error
    }
  }
}
