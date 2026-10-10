import { VideoPlatform } from '../../domain/entities/PublishedVideo'
import type { ActivePlatformAccountRepository } from '../../domain/ports/ActivePlatformAccountRepository'

export interface TikTokPublishingCapabilities {
  apiAvailable: boolean
  connected: boolean
}

/**
 * Expone al frontend si la publicación a TikTok es posible ahora mismo: si no está conectada
 * la cuenta (connected: false) o falta configuración de la app (apiAvailable: false), no hay
 * ningún camino alterno — el frontend debe pedirle al usuario conectar su cuenta de TikTok
 * antes de dejarlo publicar, sin ofrecer ninguna alternativa de exportación manual.
 *
 * No expone si la app está auditada ni el modo de publicación (direct/inbox): TikTok no tiene
 * ningún endpoint para consultar el estado de auditoría (confirmado contra la doc oficial), así
 * que ese dato no existe de antemano — cada subida lo descubre en el momento real del intento
 * (ver TikTokContentPostingUploader: intenta DIRECT_POST primero, cae a MEDIA_UPLOAD si TikTok
 * lo rechaza). Exponer un "mode"/"approved" fijo acá sería una configuración que podría no
 * reflejar la realidad.
 */
export class GetTikTokPublishingCapabilitiesUseCase {
  constructor(
    private readonly activePlatformAccountRepository: ActivePlatformAccountRepository,
    private readonly apiAvailable: boolean,
  ) {}

  async execute(organizationId: string): Promise<TikTokPublishingCapabilities> {
    const accountId = await this.activePlatformAccountRepository.findActivePlatformAccountId(organizationId, VideoPlatform.TikTok)
    return { apiAvailable: this.apiAvailable, connected: accountId !== null }
  }
}
