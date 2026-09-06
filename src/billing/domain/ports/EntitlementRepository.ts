import type { Entitlement } from '../entities/Entitlement'

export class UsageLimitExceededError extends Error {
  constructor(organizationId: string, feature: string) {
    super(`Usage limit exceeded for organization ${organizationId} on feature ${feature}`)
    this.name = 'UsageLimitExceededError'
  }
}

export interface AuthorizationContext {
  entitlement: Entitlement | null
  /** Tope de uso vigente para el feature según el plan actual del tenant — null = sin tope o sin suscripción. */
  currentUsageLimit: number | null
}

export interface EntitlementRepository {
  findByOrganizationAndFeature(organizationId: string, feature: string): Promise<Entitlement | null>
  findByOrganizationId(organizationId: string): Promise<Entitlement[]>
  /**
   * Resuelve en una sola consulta (join con subscriptions + plan_features) tanto el
   * entitlement como el tope de uso vigente del feature — evita 3 round-trips
   * secuenciales (entitlement, subscription, plan_features) en el camino caliente de
   * AuthorizeFeatureUsageUseCase.requireEntitlement.
   */
  findAuthorizationContext(organizationId: string, feature: string): Promise<AuthorizationContext>
  /** Activa el feature (usageCount arranca/resetea en 0 — activación, renovación o cambio de plan). */
  grant(organizationId: string, feature: string): Promise<void>
  /** Caso bulk de grant: activa todas las features en una sola operación (activación, renovación o cambio de plan). */
  grantAll(organizationId: string, features: string[]): Promise<void>
  /** Desactiva todas las features dadas en una sola operación. */
  deactivateAll(organizationId: string, features: string[]): Promise<void>
  /**
   * Incrementa usageCount en 1; lanza UsageLimitExceededError si ya alcanzó currentUsageLimit.
   * currentUsageLimit se resuelve en vivo desde plan_features (no se guarda copia en
   * entitlements) para que un cambio de tope aplique de inmediato a organizaciones ya
   * suscritas, sin esperar al próximo ciclo de facturación — a diferencia del precio/monto
   * de billing, que sí queda congelado por diseño (grandfathering) hasta la renovación.
   * Sin efecto si currentUsageLimit es null.
   */
  incrementUsage(organizationId: string, feature: string, currentUsageLimit: number | null): Promise<void>
}
