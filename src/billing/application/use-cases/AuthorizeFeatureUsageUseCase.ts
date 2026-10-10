import { PlanBalanceExceededError } from '../../domain/ports/EntitlementRepository'
import type { EntitlementRepository } from '../../domain/ports/EntitlementRepository'
import { InsufficientCreditsError } from '../../domain/ports/CreditAccountRepository'
import type { CreditAccountRepository } from '../../domain/ports/CreditAccountRepository'
import type { FeatureRepository } from '../../domain/ports/FeatureRepository'

export class FeatureAccessDeniedError extends Error {
  constructor(feature: string) {
    super(`Access denied for feature: ${feature}`)
    this.name = 'FeatureAccessDeniedError'
  }
}

export interface AuthorizeByEntitlementInput {
  organizationId: string
  feature: string
  /** Cantidad a consumir: 1 para features por-llamada, minutos redondeados para features por-duración de video/audio. Siempre explícito — ver GenerateYouTubeMetadataUseCase. */
  amount: number
}

/**
 * Puerto de autorización de uso reutilizable desde cualquier bounded context
 * (Shorts Intelligence, Media Editing, etc). Un solo mecanismo de "descontar unidades de
 * un balance" aplicado a dos orígenes distintos: primero el balance del plan vigente
 * (entitlements, recarga cada ciclo de facturación — ver ActivateSubscriptionUseCase /
 * RenewalUseCase / ChangePlanUseCase), y si no alcanza (o no hay plan que la incluya), el
 * balance de crédito comprado (creditAccounts, sin recarga automática, sin tope por feature,
 * libre entre cualquier feature con creditEligible=true). El límite del plan (usageLimit)
 * es propiedad exclusiva del balance-del-plan — nunca afecta ni limita al balance-de-crédito.
 */
export class AuthorizeFeatureUsageUseCase {
  constructor(
    private readonly entitlementRepository: EntitlementRepository,
    private readonly creditAccountRepository: CreditAccountRepository,
    private readonly featureRepository: FeatureRepository,
  ) {}

  async requireEntitlement(input: AuthorizeByEntitlementInput): Promise<void> {
    const { active, planBalance } = await this.entitlementRepository.findAuthorizationContext(
      input.organizationId,
      input.feature,
    )

    // planBalance === null con active=true significa "sin tope" (ver AuthorizationContext) —
    // el plan cubre ilimitado, no hace falta ni descontar del plan ni mirar crédito.
    if (active && planBalance === null) {
      return
    }

    if (active && planBalance !== null && planBalance >= input.amount) {
      try {
        await this.entitlementRepository.deductFromPlanBalance(input.organizationId, input.feature, input.amount)
        return
      } catch (error) {
        if (!(error instanceof PlanBalanceExceededError)) throw error
        // Balance agotado por otra request concurrente entre el chequeo de arriba y el
        // descuento atómico — cae a crédito igual que si nunca hubiera alcanzado.
      }
    }

    const creditEligible = await this.featureRepository.isCreditEligible(input.feature)
    if (!creditEligible) {
      throw new FeatureAccessDeniedError(input.feature)
    }

    try {
      await this.creditAccountRepository.deductCredits(input.organizationId, input.amount, input.feature)
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        throw new FeatureAccessDeniedError(input.feature)
      }
      throw error
    }
  }
}
