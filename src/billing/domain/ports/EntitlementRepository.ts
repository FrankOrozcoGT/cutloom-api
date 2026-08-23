import type { Entitlement } from '../entities/Entitlement'

export class UsageLimitExceededError extends Error {
  constructor(organizationId: string, feature: string) {
    super(`Usage limit exceeded for organization ${organizationId} on feature ${feature}`)
    this.name = 'UsageLimitExceededError'
  }
}

export interface EntitlementRepository {
  findByOrganizationAndFeature(organizationId: string, feature: string): Promise<Entitlement | null>
  findByOrganizationId(organizationId: string): Promise<Entitlement[]>
  setActive(organizationId: string, feature: string, active: boolean): Promise<void>
  /** Activa el feature y fija/resetea su tope de uso del ciclo (activación, renovación o cambio de plan). */
  grantWithUsageLimit(organizationId: string, feature: string, usageLimit: number | null): Promise<void>
  /** Incrementa usageCount en 1; lanza UsageLimitExceededError si ya alcanzó el tope. Sin efecto si usageLimit es null. */
  incrementUsage(organizationId: string, feature: string): Promise<void>
}
