import type { Feature } from '../../../shared/domain/entities/Feature'

interface EntitlementSummary {
  feature: Feature
  /** Siempre true — la lista ya solo contiene features activas ahora mismo (derivadas en vivo de la suscripción del tenant), no existe un estado "inactivo" que listar. */
  active: true
}

/**
 * Puerto propio de identity para no depender del bounded context de billing:
 * el composition root del server inyecta un adaptador respaldado por el
 * PlanFeatureAccessRepository real de billing (ver server.ts). El balance de crédito (único
 * pozo, no por feature) se consulta aparte vía GetCreditBalanceUseCase — no es parte de "qué
 * features cubre el plan".
 */
export interface EntitlementsReader {
  findByOrganizationId(organizationId: string): Promise<EntitlementSummary[]>
}
