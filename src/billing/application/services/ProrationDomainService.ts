/**
 * Cálculo de referencia del prorrateo esperado (días usados del plan actual):
 * crédito por días restantes del ciclo al precio viejo, menos cargo por esos mismos
 * días al precio nuevo. Recurrente aplica su propio prorrateo nativo al mismo tiempo
 * (mode: now_and_charge) — este cálculo es una regla de dominio propia para
 * validar/loguear el monto esperado, no se envía a la pasarela como input.
 */
export interface ProrationInput {
  currentPeriodStart: Date
  currentPeriodEnd: Date
  now: Date
  currentPlanAmountInCents: number
  newPlanAmountInCents: number
}

export interface ProrationResult {
  daysUsed: number
  daysRemaining: number
  totalDaysInCycle: number
  creditForUnusedDaysInCents: number
  chargeForRemainingDaysAtNewPlanInCents: number
  netAmountInCents: number
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

export class ProrationDomainService {
  static calculate(input: ProrationInput): ProrationResult {
    const totalDaysInCycle = Math.max(
      1,
      Math.round((input.currentPeriodEnd.getTime() - input.currentPeriodStart.getTime()) / MS_PER_DAY),
    )
    const daysUsed = Math.min(
      totalDaysInCycle,
      Math.max(0, Math.round((input.now.getTime() - input.currentPeriodStart.getTime()) / MS_PER_DAY)),
    )
    const daysRemaining = totalDaysInCycle - daysUsed

    const creditForUnusedDaysInCents = Math.round(
      (daysRemaining / totalDaysInCycle) * input.currentPlanAmountInCents,
    )
    const chargeForRemainingDaysAtNewPlanInCents = Math.round(
      (daysRemaining / totalDaysInCycle) * input.newPlanAmountInCents,
    )

    return {
      daysUsed,
      daysRemaining,
      totalDaysInCycle,
      creditForUnusedDaysInCents,
      chargeForRemainingDaysAtNewPlanInCents,
      netAmountInCents: chargeForRemainingDaysAtNewPlanInCents - creditForUnusedDaysInCents,
    }
  }
}
