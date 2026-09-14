export interface YouTubeConnectionStatus {
  connected: boolean
  /** Solo informativos, para mostrar "conectado como X" — null si no hay conexión o el token se creó antes de pedir estos scopes. */
  googleEmail: string | null
  channelTitle: string | null
}

/**
 * Puerto propio de identity para no depender del bounded context de publishing:
 * el composition root del server inyecta un adaptador respaldado por el
 * YouTubeOAuthTokenRepository real de publishing (ver server.ts).
 */
export interface YouTubeConnectionReader {
  getStatus(organizationId: string): Promise<YouTubeConnectionStatus>
}
