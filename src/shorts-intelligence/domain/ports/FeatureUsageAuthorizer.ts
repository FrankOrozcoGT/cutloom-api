export class FeatureAccessDeniedError extends Error {
  constructor(feature: string) {
    super(`Access denied for feature: ${feature}`)
    this.name = 'FeatureAccessDeniedError'
  }
}

/**
 * Puerto propio de shorts-intelligence para no depender del bounded context de
 * billing: el composition root del server inyecta un adaptador respaldado por
 * el AuthorizeFeatureUsageUseCase real de billing (ver server.ts).
 */
export interface FeatureUsageAuthorizer {
  requireEntitlement(input: { organizationId: string; feature: string }): Promise<void>
}
