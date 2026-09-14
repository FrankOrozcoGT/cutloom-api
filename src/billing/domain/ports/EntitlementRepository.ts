export class UsageLimitExceededError extends Error {
  constructor(organizationId: string, feature: string) {
    super(`Usage limit exceeded for organization ${organizationId} on feature ${feature}`)
    this.name = 'UsageLimitExceededError'
  }
}

export interface AuthorizationContext {
  /** true si la suscripción está activa y el plan actual incluye esta feature — resuelto en vivo, nunca copiado. */
  active: boolean
  usageCount: number
  /** Tope de uso vigente para el feature según el plan actual del tenant — null = sin tope o sin suscripción. */
  currentUsageLimit: number | null
}

export interface FeatureAccess {
  feature: string
  usageLimit: number | null
}

export interface EntitlementRepository {
  /**
   * Features activas de la organización ahora mismo, derivadas en vivo de su suscripción +
   * plan_features (nunca de una copia otorgada) — usado por /auth/me para informar al
   * frontend qué features tiene disponibles. Lista vacía si no hay suscripción activa.
   */
  findActiveFeaturesByOrganizationId(organizationId: string): Promise<FeatureAccess[]>
  /**
   * Resuelve en una sola consulta (join con subscriptions + plan_features + entitlements)
   * si la feature está activa, el tope vigente, y el consumo actual — evita round-trips
   * secuenciales en el camino caliente de AuthorizeFeatureUsageUseCase.requireEntitlement.
   */
  findAuthorizationContext(organizationId: string, feature: string): Promise<AuthorizationContext>
  /** Reinicia el consumo a 0 (nuevo ciclo de facturación: activación, renovación o cambio de plan). Crea el registro si no existía. */
  resetUsage(organizationId: string, feature: string): Promise<void>
  /** Caso bulk de resetUsage: reinicia el consumo de varias features en una sola operación. */
  resetUsageForFeatures(organizationId: string, features: string[]): Promise<void>
  /**
   * Incrementa usageCount en `amount` (1 para features por-llamada, minutos redondeados
   * para features por-duración de video/audio); lanza UsageLimitExceededError si el
   * resultado excedería currentUsageLimit. currentUsageLimit se resuelve en vivo desde
   * plan_features (no se guarda copia en entitlements) para que un cambio de tope aplique
   * de inmediato a organizaciones ya suscritas, sin esperar al próximo ciclo de
   * facturación — a diferencia del precio/monto de billing, que sí queda congelado por
   * diseño (grandfathering) hasta la renovación. Sin efecto si currentUsageLimit es null.
   */
  incrementUsage(organizationId: string, feature: string, amount: number, currentUsageLimit: number | null): Promise<void>
}
