import type { Feature } from '../../../shared/domain/entities/Feature'

/** Solo declara QUÉ feature cubre el plan — el CUÁNTO (creditsPerCycle) vive en Plan, no acá. */
export interface PlanFeatureProps {
  id: string
  planId: string
  feature: Feature
}

export class PlanFeature {
  private constructor(private readonly props: PlanFeatureProps) {}

  static create(props: PlanFeatureProps): PlanFeature {
    return new PlanFeature(props)
  }

  get id(): string {
    return this.props.id
  }

  get planId(): string {
    return this.props.planId
  }

  get feature(): Feature {
    return this.props.feature
  }
}
