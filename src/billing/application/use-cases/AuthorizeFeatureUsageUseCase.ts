import { InsufficientCreditsError } from '../../domain/ports/CreditAccountRepository'
import type { CreditAccountRepository } from '../../domain/ports/CreditAccountRepository'
import type { EntitlementRepository } from '../../domain/ports/EntitlementRepository'
import type { PlanRepository } from '../../domain/ports/PlanRepository'
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository'

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
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly planRepository: PlanRepository,
  ) {}

  /**
   * La feature exige entitlement activo (vía suscripción); no acepta créditos como
   * alternativa. El tope de usos por ciclo (usageLimit) se resuelve en vivo desde
   * plan_features del plan actual del tenant — no una copia congelada — para que un
   * cambio de tope aplique de inmediato a suscriptores ya activos. Agotado el tope,
   * bloquea aunque el entitlement siga activo.
   */
  async requireEntitlement(input: AuthorizeByEntitlementInput): Promise<void> {
    const entitlement = await this.entitlementRepository.findByOrganizationAndFeature(
      input.organizationId,
      input.feature,
    )
    if (!entitlement?.active) {
      throw new FeatureAccessDeniedError(input.feature)
    }

    const currentUsageLimit = await this.resolveCurrentUsageLimit(input.organizationId, input.feature)
    if (!entitlement.hasRemainingUsage(currentUsageLimit)) {
      throw new FeatureAccessDeniedError(input.feature)
    }

    await this.entitlementRepository.incrementUsage(input.organizationId, input.feature, currentUsageLimit)
  }

  private async resolveCurrentUsageLimit(organizationId: string, feature: string): Promise<number | null> {
    const subscription = await this.subscriptionRepository.findByOrganizationId(organizationId)
    if (!subscription) {
      return null
    }
    const planFeatures = await this.planRepository.findFeaturesByPlanId(subscription.planId)
    const planFeature = planFeatures.find((f) => f.feature === feature)
    return planFeature?.usageLimit ?? null
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
    const currentUsageLimit = entitlement?.active
      ? await this.resolveCurrentUsageLimit(input.organizationId, input.feature)
      : null
    if (entitlement?.active && entitlement.hasRemainingUsage(currentUsageLimit)) {
      await this.entitlementRepository.incrementUsage(input.organizationId, input.feature, currentUsageLimit)
      return
    }

    await this.requireCredits({
      organizationId: input.organizationId,
      creditsCost: input.creditsCost,
      reason: input.reason,
    })
  }
}
