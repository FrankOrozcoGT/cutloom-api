export interface EntitlementSummary {
  feature: string
  /** Siempre true — la lista ya solo contiene features activas ahora mismo (derivadas en vivo de la suscripción del tenant), no existe un estado "inactivo" que listar. Se mantiene por compatibilidad de contrato con el frontend. */
  active: true
}

/**
 * Puerto propio de identity para no depender del bounded context de billing:
 * el composition root del server inyecta un adaptador respaldado por el
 * EntitlementRepository real de billing (ver server.ts).
 */
export interface EntitlementsReader {
  findByOrganizationId(organizationId: string): Promise<EntitlementSummary[]>
}
