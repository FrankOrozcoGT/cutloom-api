import type { Feature } from '../../../shared/domain/entities/Feature'

export class FeatureAccessDeniedError extends Error {
  constructor(feature: Feature) {
    super(`Access denied for feature: ${feature}`)
    this.name = 'FeatureAccessDeniedError'
  }
}

/** Puerto de publishing: billing es dueño de la autorización real, inyectada como adaptador desde el composition root (ver server.ts). */
export interface PublishingFeatureAuthorizer {
  requireEntitlement(input: { organizationId: string; feature: Feature; amount: number }): Promise<void>
}
