export interface EntitlementSummary {
  feature: string
  /** Siempre true — la lista ya solo contiene features activas ahora mismo (derivadas en vivo de la suscripción del tenant), no existe un estado "inactivo" que listar. */
  active: true
  /** Balance restante del plan para esta feature en el ciclo actual — null = sin tope (acceso ilimitado). */
  planBalance: number | null
}

/**
 * Puerto propio de identity para no depender del bounded context de billing:
 * el composition root del server inyecta un adaptador respaldado por el
 * EntitlementRepository real de billing (ver server.ts).
 */
export interface EntitlementsReader {
  findByOrganizationId(organizationId: string): Promise<EntitlementSummary[]>
}
