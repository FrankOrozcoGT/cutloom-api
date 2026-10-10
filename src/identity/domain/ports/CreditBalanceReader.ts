/** Puerto propio de identity para no depender del bounded context de billing (ver EntitlementsReader). */
export interface CreditBalanceReader {
  findByOrganizationId(organizationId: string): Promise<number>
}
