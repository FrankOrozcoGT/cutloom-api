import type { CreditAccount } from '../entities/CreditAccount'
import type { Feature } from '../../../shared/domain/entities/Feature'

export class InsufficientCreditsError extends Error {
  constructor(organizationId: string) {
    super(`Insufficient credit balance for organization: ${organizationId}`)
    this.name = 'InsufficientCreditsError'
  }
}

/**
 * Único pozo de créditos por organización — financia tanto el consumo cubierto por el plan
 * (creditsPerCycle) como el crédito comprado aparte (topup); ambos suman al mismo balance, sin
 * distinción de origen al momento de gastar. El origen de cada movimiento (de dónde vino el
 * crédito, o para qué se gastó) se audita en el ledger (ver creditLedgerEntries y sus 3 tipos),
 * nunca en esta tabla — acá solo vive el saldo actual cacheado.
 */
export interface GrantFromPlanBulkInput {
  organizationId: string
  amount: number
  subscriptionId: string
}

export interface CreditAccountRepository {
  findOrCreateByOrganizationId(organizationId: string): Promise<CreditAccount>
  /** Entrada: acredita creditsPerCycle del plan al activar/renovar/cambiar de plan — idempotente por (subscriptionId, periodStart), ya que subscriptionId es fijo entre ciclos. */
  grantFromPlan(organizationId: string, amount: number, subscriptionId: string, periodStart: Date): Promise<CreditAccount>
  /** Caso bulk de grantFromPlan: acredita a varias organizaciones en el mismo periodStart en una sola operación — ver GrantMonthlyPlanCreditsUseCase. */
  grantFromPlanBulk(inputs: GrantFromPlanBulkInput[], periodStart: Date): Promise<void>
  /** Entrada: acredita una compra de crédito libre — idempotente por checkoutId. */
  grantFromTopup(organizationId: string, amount: number, recurrenteCheckoutId: string): Promise<CreditAccount>
  /** Salida: descuenta por consumo de `feature`; lanza InsufficientCreditsError si dejaría el balance negativo. */
  deductForUsage(organizationId: string, amount: number, feature: Feature): Promise<CreditAccount>
  /**
   * Salida: "lo que no se usó del plan, se pierde" — calcula cuánto quedó sin gastar del
   * plan_grant de `periodStart` y lo descuenta del pozo si es positivo. Idempotente por
   * (organizationId, periodStart) — no vuelve a expirar un mes ya cerrado.
   */
  expireUnusedPlanGrants(organizationId: string, periodStart: Date): Promise<CreditAccount>
  /** Caso bulk de expireUnusedPlanGrants: cierra el periodStart de varias organizaciones en una sola operación — ver GrantMonthlyPlanCreditsUseCase. */
  expireUnusedPlanGrantsBulk(organizationIds: string[], periodStart: Date): Promise<void>
}
