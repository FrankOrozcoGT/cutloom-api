export interface EntitlementProps {
  id: string
  organizationId: string
  feature: string
  active: boolean
  /** null = sin tope de usos por ciclo (acceso binario); number = usos restantes permitidos. */
  usageLimit: number | null
  usageCount: number
}

export class Entitlement {
  private constructor(private readonly props: EntitlementProps) {}

  static create(props: EntitlementProps): Entitlement {
    return new Entitlement(props)
  }

  get id(): string {
    return this.props.id
  }

  get organizationId(): string {
    return this.props.organizationId
  }

  get feature(): string {
    return this.props.feature
  }

  get active(): boolean {
    return this.props.active
  }

  get usageLimit(): number | null {
    return this.props.usageLimit
  }

  get usageCount(): number {
    return this.props.usageCount
  }

  /** Sin límite configurado (usageLimit null) siempre autoriza mientras esté active. */
  hasRemainingUsage(): boolean {
    if (this.props.usageLimit === null) return true
    return this.props.usageCount < this.props.usageLimit
  }
}
