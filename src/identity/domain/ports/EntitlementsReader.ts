export interface EntitlementSummary {
  feature: string
  active: boolean
}

/**
 * Puerto propio de identity para no depender del bounded context de billing:
 * el composition root del server inyecta un adaptador respaldado por el
 * EntitlementRepository real de billing (ver server.ts).
 */
export interface EntitlementsReader {
  findByOrganizationId(organizationId: string): Promise<EntitlementSummary[]>
}
