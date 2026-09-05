export interface EntitlementProps {
  id: string
  organizationId: string
  feature: string
  active: boolean
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

  get usageCount(): number {
    return this.props.usageCount
  }

  /**
   * currentUsageLimit se resuelve en vivo desde plan_features (no vive en el
   * entitlement) — así un cambio de tope aplica de inmediato a organizaciones ya
   * suscritas. null = sin límite configurado, siempre autoriza mientras esté active.
   */
  hasRemainingUsage(currentUsageLimit: number | null): boolean {
    if (currentUsageLimit === null) return true
    return this.props.usageCount < currentUsageLimit
  }

  toJSON(): EntitlementProps {
    return { ...this.props }
  }
}
