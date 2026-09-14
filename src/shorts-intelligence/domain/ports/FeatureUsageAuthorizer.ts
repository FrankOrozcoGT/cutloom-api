export class FeatureAccessDeniedError extends Error {
  constructor(feature: string) {
    super(`Access denied for feature: ${feature}`)
    this.name = 'FeatureAccessDeniedError'
  }
}

/** Puerto de shorts-intelligence: billing es dueño de la autorización real, inyectada como adaptador desde el composition root (ver server.ts). */
export interface FeatureUsageAuthorizer {
  /** amount: 1 para features por-llamada, minutos redondeados para features por-duración de video/audio (ver domain/minutes.ts). */
  requireEntitlement(input: { organizationId: string; feature: string; amount?: number }): Promise<void>
}
