import type { Feature } from '../../../shared/domain/entities/Feature'

/**
 * Resuelve en vivo (nunca de una copia otorgada) qué features cubre la suscripción activa de
 * una organización — "¿esta organización puede pagar esta feature con su plan?", independiente
 * de si tiene saldo (eso lo resuelve CreditAccountRepository, un único pozo compartido). Evita
 * que editar el catálogo de un plan ya existente deje a las organizaciones suscritas con datos
 * desincronizados.
 */
export interface PlanFeatureAccessRepository {
  /** Features cubiertas por el plan activo ahora mismo — usado por /auth/me. Lista vacía si no hay suscripción activa. */
  findActiveFeaturesByOrganizationId(organizationId: string): Promise<Feature[]>
  /** true si la suscripción activa de la organización incluye esta feature. */
  isCoveredByActivePlan(organizationId: string, feature: Feature): Promise<boolean>
}
