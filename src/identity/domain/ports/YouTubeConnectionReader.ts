/**
 * Puerto propio de identity para no depender del bounded context de publishing:
 * el composition root del server inyecta un adaptador respaldado por el
 * YouTubeOAuthTokenRepository real de publishing (ver server.ts).
 */
export interface YouTubeConnectionReader {
  isConnected(organizationId: string): Promise<boolean>
}
