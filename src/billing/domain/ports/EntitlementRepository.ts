export class PlanBalanceExceededError extends Error {
  constructor(organizationId: string, feature: string) {
    super(`Plan balance exceeded for organization ${organizationId} on feature ${feature}`)
    this.name = 'PlanBalanceExceededError'
  }
}

export interface AuthorizationContext {
  /** true si la suscripción está activa y el plan actual incluye esta feature — resuelto en vivo, nunca copiado. */
  active: boolean
  /** Balance restante de este ciclo (entitlements.balance) — null = la feature no tiene tope
   * (plan_features.usageLimit null): nunca se consume del plan, el flujo de decisión pasa
   * directo a crédito (ver AuthorizeFeatureUsageUseCase). */
  planBalance: number | null
}

export interface FeatureAccess {
  feature: string
  usageLimit: number | null
  /** Balance restante del plan para esta feature en el ciclo actual — null si usageLimit es null (sin tope) o si todavía no se cargó ningún balance para esta feature. */
  planBalance: number | null
}

export interface EntitlementRepository {
  /**
   * Features activas de la organización ahora mismo, derivadas en vivo de su suscripción +
   * plan_features (nunca de una copia otorgada) — usado por /auth/me para informar al
   * frontend qué features tiene disponibles. Lista vacía si no hay suscripción activa.
   */
  findActiveFeaturesByOrganizationId(organizationId: string): Promise<FeatureAccess[]>
  /**
   * Resuelve en una sola consulta (join con subscriptions + plan_features + entitlements)
   * si la feature está activa y el balance restante del plan para este ciclo — evita
   * round-trips secuenciales en el camino caliente de AuthorizeFeatureUsageUseCase.
   */
  findAuthorizationContext(organizationId: string, feature: string): Promise<AuthorizationContext>
  /**
   * Carga el balance al tope del plan vigente (nuevo ciclo de facturación: activación,
   * renovación o cambio de plan) — el consumo del ciclo anterior no se arrastra. Crea el
   * registro si no existía. `usageLimit: null` carga `balance: null` (sin tope, ver
   * AuthorizationContext).
   */
  chargeBalanceForFeatures(organizationId: string, features: { feature: string; usageLimit: number | null }[]): Promise<void>
  /**
   * Descuenta `amount` del balance del plan; lanza PlanBalanceExceededError si el balance
   * actual no alcanza. Sin efecto (no lanza) si el balance es null (feature sin tope).
   */
  deductFromPlanBalance(organizationId: string, feature: string, amount: number): Promise<void>
}
