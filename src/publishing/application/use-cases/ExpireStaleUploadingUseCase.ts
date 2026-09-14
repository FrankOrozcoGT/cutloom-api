import type { YouTubeVideoRepository } from '../../domain/ports/YouTubeVideoRepository'

// Si un upload real a YouTube (streaming de varios GB) tarda más que esto sin confirmarse
// (markUploaded/markFailed), algo se rompió a mitad de camino (crash del proceso, cliente
// cortó la conexión) — no hay forma de saber si YouTube igual terminó de recibirlo sin
// consultar su API, así que se marca Failed en vez de asumir éxito.
const STALE_UPLOADING_THRESHOLD_MS = 2 * 60 * 60 * 1000

export class ExpireStaleUploadingUseCase {
  constructor(private readonly youTubeVideoRepository: YouTubeVideoRepository) {}

  async execute(): Promise<number> {
    const olderThan = new Date(Date.now() - STALE_UPLOADING_THRESHOLD_MS)
    return this.youTubeVideoRepository.expireStaleUploading(olderThan)
  }
}
