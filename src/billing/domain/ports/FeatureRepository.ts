import type { Feature } from '../../../shared/domain/entities/Feature'

export interface FeatureRepository {
  /** false si la feature no existe en el catálogo — por seguridad, nunca permite crédito para una feature no registrada. */
  isCreditEligible(feature: Feature): Promise<boolean>
}
