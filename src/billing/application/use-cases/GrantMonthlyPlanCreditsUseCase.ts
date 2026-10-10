import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository'
import type { CreditAccountRepository } from '../../domain/ports/CreditAccountRepository'
import type { PlanRepository } from '../../domain/ports/PlanRepository'

/**
 * Recarga mensual del pozo de créditos de CUALQUIER suscripción activa — independiente de su
 * ciclo de cobro real (mensual o anual). El pago (Recurrente) y la recarga de créditos son dos
 * relojes distintos: pagar define cuánto y cada cuánto se cobra dinero; esta recarga define
 * cuánto y cada cuánto se acredita capacidad de uso, siempre mensual sin importar el plan.
 * Corre el día 1 de cada mes (ver Bun.cron en server.ts). Antes de otorgar el grant del mes
 * nuevo, cierra el mes vencido (use it or lose it).
 */
export class GrantMonthlyPlanCreditsUseCase {
  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly creditAccountRepository: CreditAccountRepository,
    private readonly planRepository: PlanRepository,
  ) {}

  async execute(now: Date = new Date()): Promise<void> {
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const previousPeriodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    const activeSubscriptions = await this.subscriptionRepository.findAllActive()
    if (activeSubscriptions.length === 0) return

    const plans = await this.planRepository.findByIds(activeSubscriptions.map((s) => s.planId))
    const plansById = new Map(plans.map((p) => [p.id, p]))

    const grants = activeSubscriptions
      .map((subscription) => {
        const plan = plansById.get(subscription.planId)
        if (!plan) return null
        return { organizationId: subscription.organizationId, amount: plan.creditsPerCycle, subscriptionId: subscription.id }
      })
      .filter((grant) => grant !== null)

    await this.creditAccountRepository.expireUnusedPlanGrantsBulk(
      grants.map((g) => g.organizationId),
      previousPeriodStart,
    )
    await this.creditAccountRepository.grantFromPlanBulk(grants, periodStart)
  }
}
