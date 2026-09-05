import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: [
    './src/identity/infrastructure/db/schema.ts',
    './src/billing/infrastructure/db/schema.ts',
    './src/shorts-intelligence/infrastructure/db/schema.ts',
  ],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
})
