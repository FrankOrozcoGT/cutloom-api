import type { CreditAccountRepository } from '../../domain/ports/CreditAccountRepository'

export interface DeductCreditsInput {
  organizationId: string
  amount: number
  reason: string
}

export interface DeductCreditsResult {
  balance: number
}

/** Consumo de funcionalidad pago-por-uso. No permite balance negativo (regla de dominio en el repositorio). */
export class DeductCreditsUseCase {
  constructor(private readonly creditAccountRepository: CreditAccountRepository) {}

  async execute(input: DeductCreditsInput): Promise<DeductCreditsResult> {
    const account = await this.creditAccountRepository.deductCredits(input.organizationId, input.amount, input.reason)
    return { balance: account.balance }
  }
}
