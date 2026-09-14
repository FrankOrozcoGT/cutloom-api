import type { YouTubeOAuthPort } from '../../domain/ports/YouTubeOAuthPort'

export class StartYouTubeOAuthUseCase {
  constructor(private readonly youTubeOAuthProvider: YouTubeOAuthPort) {}

  execute(state: string): string {
    return this.youTubeOAuthProvider.buildAuthorizationUrl(state)
  }
}
