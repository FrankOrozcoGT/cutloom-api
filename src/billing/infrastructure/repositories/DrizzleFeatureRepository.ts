import { eq } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { features } from '../db/schema'
import type { FeatureRepository } from '../../domain/ports/FeatureRepository'

export class DrizzleFeatureRepository implements FeatureRepository {
  constructor(private readonly db: Database) {}

  async isCreditEligible(feature: string): Promise<boolean> {
    const [row] = await this.db
      .select({ creditEligible: features.creditEligible })
      .from(features)
      .where(eq(features.id, feature))
      .limit(1)
    return row?.creditEligible ?? false
  }
}
