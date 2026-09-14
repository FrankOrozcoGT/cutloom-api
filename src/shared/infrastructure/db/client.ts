import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as identitySchema from '../../../identity/infrastructure/db/schema'
import * as billingSchema from '../../../billing/infrastructure/db/schema'
import * as shortsIntelligenceSchema from '../../../shorts-intelligence/infrastructure/db/schema'
import * as publishingSchema from '../../../publishing/infrastructure/db/schema'

const schema = { ...identitySchema, ...billingSchema, ...shortsIntelligenceSchema, ...publishingSchema }

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required')
}

const queryClient = postgres(connectionString)

export const db = drizzle(queryClient, { schema })

export type Database = typeof db
