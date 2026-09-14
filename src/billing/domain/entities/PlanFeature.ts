export interface PlanFeatureProps {
  id: string
  planId: string
  feature: string
  /** null = acceso ilimitado por ciclo; number = tope de usos por ciclo de facturación. */
  usageLimit: number | null
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

  get feature(): string {
    return this.props.feature
  }

  get usageLimit(): number | null {
    return this.props.usageLimit
  }
}
