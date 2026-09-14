import type { CreditAccount } from '../entities/CreditAccount'

export class InsufficientCreditsError extends Error {
  constructor(organizationId: string) {
    super(`Insufficient credit balance for organization: ${organizationId}`)
    this.name = 'InsufficientCreditsError'
  }
}

export interface CreditAccountRepository {
  findOrCreateByOrganizationId(organizationId: string): Promise<CreditAccount>
  /** Suma amount al balance (positivo) y registra la transacción; idempotente por checkoutId. */
  addCredits(organizationId: string, amount: number, recurrenteCheckoutId: string): Promise<CreditAccount>
  /** Descuenta amount del balance; lanza InsufficientCreditsError si dejaría el balance negativo. */
  deductCredits(organizationId: string, amount: number, reason: string): Promise<CreditAccount>
}
