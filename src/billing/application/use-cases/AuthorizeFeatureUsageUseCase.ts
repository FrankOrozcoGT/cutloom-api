import { InsufficientCreditsError } from '../../domain/ports/CreditAccountRepository'
import type { CreditAccountRepository } from '../../domain/ports/CreditAccountRepository'
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

export interface AuthorizeByCreditsInput {
  organizationId: string
  creditsCost: number
  reason: string
}

export interface AuthorizeEitherInput {
  organizationId: string
  feature: string
  creditsCost: number
  reason: string
}

/**
 * Puerto de autorización de uso reutilizable desde cualquier bounded context
 * (Shorts Intelligence, Media Editing, etc). La REGLA de qué combinación exige
 * cada feature (solo suscripción / solo créditos / cualquiera de las dos) la
 * decide el caso de uso consumidor llamando al método que corresponda — este
 * servicio no conoce ni impone políticas por feature, solo expone los dos
 * mecanismos de acceso de billing de forma componible.
 */
export class AuthorizeFeatureUsageUseCase {
  constructor(
    private readonly entitlementRepository: EntitlementRepository,
    private readonly creditAccountRepository: CreditAccountRepository,
  ) {}

  /**
   * La feature exige entitlement activo (vía suscripción); no acepta créditos como
   * alternativa. Si el plan del tenant tiene tope de usos por ciclo (usageLimit), se
   * descuenta un uso; agotado el tope, bloquea aunque el entitlement siga activo.
   */
  async requireEntitlement(input: AuthorizeByEntitlementInput): Promise<void> {
    const entitlement = await this.entitlementRepository.findByOrganizationAndFeature(
      input.organizationId,
      input.feature,
    )
    if (!entitlement?.active || !entitlement.hasRemainingUsage()) {
      throw new FeatureAccessDeniedError(input.feature)
    }

    await this.entitlementRepository.incrementUsage(input.organizationId, input.feature)
  }

  /** La feature exige créditos suficientes; los descuenta si autoriza. No acepta entitlement como alternativa. */
  async requireCredits(input: AuthorizeByCreditsInput): Promise<void> {
    try {
      await this.creditAccountRepository.deductCredits(input.organizationId, input.creditsCost, input.reason)
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        throw new FeatureAccessDeniedError(input.reason)
      }
      throw error
    }
  }

  /**
   * La feature acepta cualquiera de los dos caminos: si el tenant tiene el
   * entitlement activo y con usos restantes, pasa sin costo (consume un uso); si no
   * (sin entitlement, o entitlement con tope agotado), se descuentan créditos. Solo
   * bloquea si ninguno de los dos cubre el acceso.
   */
  async requireEntitlementOrCredits(input: AuthorizeEitherInput): Promise<void> {
    const entitlement = await this.entitlementRepository.findByOrganizationAndFeature(
      input.organizationId,
      input.feature,
    )
    if (entitlement?.active && entitlement.hasRemainingUsage()) {
      await this.entitlementRepository.incrementUsage(input.organizationId, input.feature)
      return
    }

    await this.requireCredits({
      organizationId: input.organizationId,
      creditsCost: input.creditsCost,
      reason: input.reason,
    })
  }
}
