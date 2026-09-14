export class PlanNotFoundError extends Error {
  constructor(planId: string) {
    super(`Plan not found: ${planId}`)
    this.name = 'PlanNotFoundError'
  }
}

export class NoActiveSubscriptionError extends Error {
  constructor(organizationId: string) {
    super(`No active subscription found for organization: ${organizationId}`)
    this.name = 'NoActiveSubscriptionError'
  }
}
