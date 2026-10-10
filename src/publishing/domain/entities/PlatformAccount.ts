import type { VideoPlatform } from './PublishedVideo'

export interface PlatformAccountProps {
  id: string
  organizationId: string
  platform: VideoPlatform
  /** Id real y estable de la cuenta en la plataforma (YouTube: channelId; TikTok: openId) — nunca inventado, siempre el identificador que la propia plataforma devuelve. Es la clave de unicidad real de esta entidad: la misma cuenta reconectada más de una vez siempre resuelve al mismo registro. */
  externalAccountId: string
  /** Solo informativo (mostrar "conectado como X" en el frontend) — shape distinto por plataforma (YouTube: { googleEmail, channelTitle }; TikTok: { openId, displayName }), opaco para el dominio compartido. */
  platformAccountInfo: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Una cuenta de plataforma conectada alguna vez por una organización — persiste aunque la
 * organización deje de usarla (cambie a otra cuenta), para no perder el historial de qué cuenta
 * publicó cada PublishedVideo existente. Distinta de "cuál cuenta uso ahora" (ver
 * ActivePlatformAccount), que sí cambia cuando la organización reconecta con otra cuenta.
 */
export class PlatformAccount {
  private constructor(private readonly props: PlatformAccountProps) {}

  static create(props: PlatformAccountProps): PlatformAccount {
    return new PlatformAccount(props)
  }

  get id(): string {
    return this.props.id
  }

  get organizationId(): string {
    return this.props.organizationId
  }

  get platform(): VideoPlatform {
    return this.props.platform
  }

  get externalAccountId(): string {
    return this.props.externalAccountId
  }

  get platformAccountInfo(): Record<string, unknown> | null {
    return this.props.platformAccountInfo
  }

  get createdAt(): Date {
    return this.props.createdAt
  }

  get updatedAt(): Date {
    return this.props.updatedAt
  }
}
