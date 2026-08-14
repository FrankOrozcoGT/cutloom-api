import type { Organization } from '../entities/Organization'

export interface CreateOrganizationInput {
  name: string
}

export interface OrganizationRepository {
  findById(id: string): Promise<Organization | null>
  create(input: CreateOrganizationInput): Promise<Organization>
}
