import type { PlatformAccount } from '../entities/PlatformAccount'
import type { VideoPlatform } from '../entities/PublishedVideo'

export interface FindOrCreatePlatformAccountInput {
  organizationId: string
  platform: VideoPlatform
  externalAccountId: string
  platformAccountInfo: Record<string, unknown> | null
}

export interface PlatformAccountRepository {
  /**
   * Resuelve la cuenta por su identificador real en la plataforma (externalAccountId) — si ya
   * existía (la organización la había conectado antes), actualiza platformAccountInfo y devuelve
   * ese mismo registro; si no, crea uno nuevo. Nunca duplica una cuenta ya vista, incluso si la
   * organización la desconecta y reconecta varias veces.
   */
  findOrCreate(input: FindOrCreatePlatformAccountInput): Promise<PlatformAccount>
  findById(id: string): Promise<PlatformAccount | null>
}
