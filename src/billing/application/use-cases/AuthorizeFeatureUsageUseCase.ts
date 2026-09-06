import type { EntitlementRepository } from '../../domain/ports/EntitlementRepository'

export class FeatureAccessDeniedError extends Error {
  constructor(feature: string) {
    super(`Access denied for feature: ${feature}`)
    this.name = 'FeatureAccessDeniedError'
  }
}

export interface AuthorizeByEntitlementInput {
  organizationId: string
  feature: string
}

/**
 * Puerto de autorización de uso reutilizable desde cualquier bounded context
 * (Shorts Intelligence, Media Editing, etc).
 */
export class AuthorizeFeatureUsageUseCase {
  constructor(private readonly entitlementRepository: EntitlementRepository) {}

  /**
   * La feature exige entitlement activo (vía suscripción). El tope de usos por ciclo
   * (usageLimit) se resuelve en vivo desde plan_features del plan actual del tenant —
   * no una copia congelada — para que un cambio de tope aplique de inmediato a
   * suscriptores ya activos. Agotado el tope, bloquea aunque el entitlement siga activo.
   */
  async requireEntitlement(input: AuthorizeByEntitlementInput): Promise<void> {
    const { entitlement, currentUsageLimit } = await this.entitlementRepository.findAuthorizationContext(
      input.organizationId,
      input.feature,
    )
    if (!entitlement?.active) {
      throw new FeatureAccessDeniedError(input.feature)
    }
    if (!entitlement.hasRemainingUsage(currentUsageLimit)) {
      throw new FeatureAccessDeniedError(input.feature)
    }

    await this.entitlementRepository.incrementUsage(input.organizationId, input.feature, currentUsageLimit)
  }
}
