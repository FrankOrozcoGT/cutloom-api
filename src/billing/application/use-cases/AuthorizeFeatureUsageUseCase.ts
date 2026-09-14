import { UsageLimitExceededError } from '../../domain/ports/EntitlementRepository'
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
  /** Cantidad a consumir del tope: 1 para features por-llamada, minutos redondeados para features por-duración de video/audio. */
  amount?: number
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
    const amount = input.amount ?? 1
    const { active, usageCount, currentUsageLimit } = await this.entitlementRepository.findAuthorizationContext(
      input.organizationId,
      input.feature,
    )
    if (!active) {
      throw new FeatureAccessDeniedError(input.feature)
    }
    if (currentUsageLimit !== null && usageCount + amount > currentUsageLimit) {
      throw new FeatureAccessDeniedError(input.feature)
    }

    try {
      await this.entitlementRepository.incrementUsage(input.organizationId, input.feature, amount, currentUsageLimit)
    } catch (error) {
      if (error instanceof UsageLimitExceededError) {
        // Tope agotado por otra request concurrente entre el chequeo de arriba y el
        // incremento atómico — mismo resultado observable para el caller que el chequeo
        // "normal" de tope agotado.
        throw new FeatureAccessDeniedError(input.feature)
      }
      throw error
    }
  }
}
