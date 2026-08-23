import type { CreditAccountRepository } from '../../domain/ports/CreditAccountRepository'

export interface GetCreditBalanceResult {
  balance: number
}

export class GetCreditBalanceUseCase {
  constructor(private readonly creditAccountRepository: CreditAccountRepository) {}

  async execute(organizationId: string): Promise<GetCreditBalanceResult> {
    const account = await this.creditAccountRepository.findOrCreateByOrganizationId(organizationId)
    return { balance: account.balance }
  }
}
