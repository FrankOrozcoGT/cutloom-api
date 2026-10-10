interface PlatformConnectionStatus {
  connected: boolean
  /** Datos de cuenta específicos de la plataforma, solo informativos (mostrar "conectado como X") — shape distinto por proveedor (YouTube: { googleEmail, channelTitle }; TikTok: { openId, displayName }), opaco para el caller. null si no hay conexión. */
  platformAccountInfo: Record<string, unknown> | null
}

/**
 * Puerto único de identity para no depender del bounded context de publishing — el
 * composition root del server inyecta un adaptador respaldado por el
 * PlatformOAuthTokenRepository real de publishing, instanciado una vez por plataforma (ver server.ts).
 */
export interface PlatformConnectionReader {
  getStatus(organizationId: string): Promise<PlatformConnectionStatus>
}
