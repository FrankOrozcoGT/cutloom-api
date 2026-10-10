import type { VideoPlatform } from '../entities/PublishedVideo'

export interface ActivePlatformAccountRepository {
  /** La cuenta que la organización usa ahora para esta plataforma — null si nunca conectó ninguna. Independiente por plataforma: una organización puede tener una cuenta activa de YouTube y otra distinta de TikTok al mismo tiempo. */
  findActivePlatformAccountId(organizationId: string, platform: VideoPlatform): Promise<string | null>
  /** Reemplaza (o crea) cuál cuenta es la activa para esta organización+plataforma — se llama tras cada conexión OAuth exitosa, sin importar si la cuenta ya existía (PlatformAccount) o es nueva. */
  setActivePlatformAccount(organizationId: string, platform: VideoPlatform, platformAccountId: string): Promise<void>
}
