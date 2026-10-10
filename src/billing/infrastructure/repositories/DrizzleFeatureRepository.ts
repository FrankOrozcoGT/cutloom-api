import { eq } from 'drizzle-orm'
import type { Database } from '../../../shared/infrastructure/db/client'
import { features } from '../../../shared/infrastructure/db/schema'
import type { FeatureRepository } from '../../domain/ports/FeatureRepository'
import type { Feature } from '../../../shared/domain/entities/Feature'

export class DrizzleFeatureRepository implements FeatureRepository {
  constructor(private readonly db: Database) {}

  async isCreditEligible(feature: Feature): Promise<boolean> {
    const [row] = await this.db
      .select({ creditEligible: features.creditEligible })
      .from(features)
      .where(eq(features.id, feature))
      .limit(1)
    return row?.creditEligible ?? false
  }
}
