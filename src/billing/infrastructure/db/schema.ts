import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { organizations } from '../../../identity/infrastructure/db/schema'

export const subscriptionStatusEnum = pgEnum('subscription_status', ['active', 'past_due', 'inactive'])
export const subscriptionIntervalEnum = pgEnum('subscription_interval', ['month', 'year'])
export const paymentStatusEnum = pgEnum('payment_status', ['pending', 'succeeded', 'failed'])

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  recurrentePriceId: text('recurrente_price_id').notNull(),
  amountInCents: integer('amount_in_cents').notNull(),
  currency: text('currency').notNull(),
  interval: subscriptionIntervalEnum('interval').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const planFeatures = pgTable(
  'plan_features',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    feature: text('feature').notNull(),
    // null = acceso ilimitado durante el ciclo; number = tope de usos por ciclo de facturación.
    usageLimit: integer('usage_limit'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('plan_features_plan_id_feature_idx').on(table.planId, table.feature)],
)

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    recurrenteSubscriptionId: text('recurrente_subscription_id'),
    recurrenteCheckoutId: text('recurrente_checkout_id'),
    status: subscriptionStatusEnum('status').notNull().default('inactive'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    gracePeriodEndsAt: timestamp('grace_period_ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('subscriptions_organization_id_idx').on(table.organizationId),
    uniqueIndex('subscriptions_recurrente_subscription_id_idx').on(table.recurrenteSubscriptionId),
    uniqueIndex('subscriptions_recurrente_checkout_id_idx').on(table.recurrenteCheckoutId),
  ],
)

export const entitlements = pgTable(
  'entitlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    feature: text('feature').notNull(),
    active: boolean('active').notNull().default(false),
    // El tope de uso (usageLimit) NO se copia aquí — se resuelve en vivo desde
    // plan_features.usage_limit en cada AuthorizeFeatureUsageUseCase.requireEntitlement,
    // así un cambio de tope aplica de inmediato a organizaciones ya suscritas sin esperar
    // renovación. usageCount sí vive aquí porque es consumo real por ciclo de facturación
    // (se resetea en activación/renovación/cambio de plan, ver Activate/Renewal/ChangePlanUseCase).
    usageCount: integer('usage_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('entitlements_organization_id_feature_idx').on(table.organizationId, table.feature)],
)

export const creditAccounts = pgTable(
  'credit_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    balance: integer('balance').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('credit_accounts_organization_id_idx').on(table.organizationId)],
)

export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    amount: integer('amount').notNull(),
    reason: text('reason').notNull(),
    recurrenteCheckoutId: text('recurrente_checkout_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('credit_transactions_organization_id_idx').on(table.organizationId),
    uniqueIndex('credit_transactions_recurrente_checkout_id_idx').on(table.recurrenteCheckoutId),
  ],
)

export const donations = pgTable('donations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
  amountInCents: integer('amount_in_cents').notNull(),
  currency: text('currency').notNull(),
  status: paymentStatusEnum('status').notNull().default('pending'),
  recurrenteCheckoutId: text('recurrente_checkout_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('donations_recurrente_checkout_id_idx').on(table.recurrenteCheckoutId)])
