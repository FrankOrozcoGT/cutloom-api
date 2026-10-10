import { InsufficientCreditsError } from '../../domain/ports/CreditAccountRepository'
import type { CreditAccountRepository } from '../../domain/ports/CreditAccountRepository'
import type { PlanFeatureAccessRepository } from '../../domain/ports/PlanFeatureAccessRepository'
import type { FeatureRepository } from '../../domain/ports/FeatureRepository'
import type { Feature } from '../../../shared/domain/entities/Feature'

export class FeatureAccessDeniedError extends Error {
  constructor(feature: Feature) {
    super(`Access denied for feature: ${feature}`)
    this.name = 'FeatureAccessDeniedError'
  }
}

export interface AuthorizeByEntitlementInput {
  organizationId: string
  feature: Feature
  /** Cantidad a consumir: 1 para features por-llamada, minutos redondeados para features por-duración de video/audio. Siempre explícito — ver GenerateYouTubeMetadataUseCase. */
  amount: number
}

/**
 * Puerto de autorización de uso reutilizable desde cualquier bounded context (Shorts
 * Intelligence, Media Editing, etc). Un único pozo de créditos por organización
 * (CreditAccountRepository) financia tanto el consumo cubierto por el plan como el crédito
 * comprado aparte — no hay dos balances que comparar. Lo único que decide si esta operación
 * puede gastar de ese pozo es el DERECHO: la feature está cubierta por el plan activo
 * (PlanFeatureAccessRepository), o la feature acepta pagarse con crédito libre
 * (FeatureRepository.isCreditEligible) si no hay plan que la cubra.
 */
export class AuthorizeFeatureUsageUseCase {
  constructor(
    private readonly planFeatureAccessRepository: PlanFeatureAccessRepository,
    private readonly creditAccountRepository: CreditAccountRepository,
    private readonly featureRepository: FeatureRepository,
  ) {}

  async requireEntitlement(input: AuthorizeByEntitlementInput): Promise<void> {
    const coveredByPlan = await this.planFeatureAccessRepository.isCoveredByActivePlan(input.organizationId, input.feature)

    if (!coveredByPlan) {
      const creditEligible = await this.featureRepository.isCreditEligible(input.feature)
      if (!creditEligible) {
        throw new FeatureAccessDeniedError(input.feature)
      }
    }

    try {
      await this.creditAccountRepository.deductForUsage(input.organizationId, input.amount, input.feature)
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        throw new FeatureAccessDeniedError(input.feature)
      }
      throw error
    }
  }
}
