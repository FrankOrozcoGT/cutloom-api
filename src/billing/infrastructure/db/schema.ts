import { boolean, index, integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { organizations } from '../../../identity/infrastructure/db/schema'
import { features } from '../../../shared/infrastructure/db/schema'
import type { Feature } from '../../../shared/domain/entities/Feature'
import type { CreditLedgerEntryType } from '../../domain/entities/CreditLedgerEntryType'

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
  // Créditos que se acreditan a creditAccount.balance cada vez que se paga este plan (alta,
  // renovación o cambio de plan) — un solo pozo total, no desglosado por feature (ver
  // CREDIT_LEDGER_PLAN_GRANTS). Qué features puede pagar ese pozo lo decide planFeatures.
  creditsPerCycle: integer('credits_per_cycle').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Solo QUÉ features cubre el plan — el CUÁNTO (creditsPerCycle) vive en plans, no acá: un
// plan da un único pozo de créditos, no un tope independiente por feature.
export const planFeatures = pgTable(
  'plan_features',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    feature: text('feature')
      .notNull()
      .references(() => features.id, { onDelete: 'restrict' })
      .$type<Feature>(),
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

// unidades genéricas (minutos, llamadas, lo que cada feature defina) — NO dinero. Único pozo
// de crédito por organización, sin desglose por feature ni por origen (plan vs. comprado): el
// historial/origen de cada movimiento vive en creditLedgerEntries; esta tabla es solo el saldo
// actual cacheado para lectura rápida en el camino caliente de autorización.
export const creditAccount = pgTable(
  'credit_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    balance: integer('balance').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('credit_account_organization_id_idx').on(table.organizationId)],
)

// Supertipo (patrón class-table): solo atributos verdaderos para TODO movimiento de crédito,
// sin importar su origen — monto con signo (+ entrada, - salida), tipo, organización, cuándo.
// Cada tipo tiene su propia tabla hija 1:1 con el dato específico que le pertenece (ver
// creditLedgerPlanGrants/creditLedgerTopups/creditLedgerUsages/creditLedgerExpirations) — evita
// columnas nullable condicionales según el tipo de fila (alerta de normalización). `type` es
// text plano en vez de pgEnum: agregar un tipo nuevo es un cambio de código (ver
// CreditLedgerEntryType), nunca una migración ALTER TYPE.
export const creditLedgerEntries = pgTable(
  'credit_ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    amount: integer('amount').notNull(),
    type: text('type').notNull().$type<CreditLedgerEntryType>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('credit_ledger_entries_organization_id_idx').on(table.organizationId)],
)

// Entrada: el plan acredita su creditsPerCycle al activar/renovar/cambiar de plan. Idempotente
// por (subscriptionId, periodStart) — subscriptionId es fijo por toda la vida de la
// suscripción (no cambia entre ciclos), así que periodStart es lo que distingue cada ciclo real
// de facturación y evita doble acreditación ante reintentos del webhook de Recurrente.
export const creditLedgerPlanGrants = pgTable(
  'credit_ledger_plan_grants',
  {
    ledgerEntryId: uuid('ledger_entry_id')
      .primaryKey()
      .references(() => creditLedgerEntries.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'restrict' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('credit_ledger_plan_grants_subscription_id_period_start_idx').on(table.subscriptionId, table.periodStart)],
)

// Entrada: compra de crédito libre, pago único vía Recurrente — idempotente por checkoutId.
export const creditLedgerTopups = pgTable(
  'credit_ledger_topups',
  {
    ledgerEntryId: uuid('ledger_entry_id')
      .primaryKey()
      .references(() => creditLedgerEntries.id, { onDelete: 'cascade' }),
    recurrenteCheckoutId: text('recurrente_checkout_id').notNull(),
  },
  (table) => [uniqueIndex('credit_ledger_topups_recurrente_checkout_id_idx').on(table.recurrenteCheckoutId)],
)

// Salida: consumo real de una feature — siempre atada a cuál, a diferencia de las entradas.
export const creditLedgerUsages = pgTable('credit_ledger_usages', {
  ledgerEntryId: uuid('ledger_entry_id')
    .primaryKey()
    .references(() => creditLedgerEntries.id, { onDelete: 'cascade' }),
  feature: text('feature')
    .notNull()
    .references(() => features.id, { onDelete: 'restrict' })
    .$type<Feature>(),
})

// Salida: "lo que no se usó del plan, se pierde" — ajuste al cerrar el mes vencido, por el
// sobrante entre lo acreditado (plan_grant) y lo gastado (usage) en ese mismo periodStart.
// Idempotente por (organizationId, periodStart): un mes ya cerrado de esta organización no
// vuelve a expirar. organizationId se duplica acá (ya vive en creditLedgerEntries, la fila
// padre) porque la unicidad real es por organización, no global — un periodStart compartido
// entre organizaciones distintas no debe colisionar.
export const creditLedgerExpirations = pgTable(
  'credit_ledger_expirations',
  {
    ledgerEntryId: uuid('ledger_entry_id')
      .primaryKey()
      .references(() => creditLedgerEntries.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('credit_ledger_expirations_organization_id_period_start_idx').on(table.organizationId, table.periodStart)],
)

// Una sola fila vigente a la vez (la última por effective_from) — todas las réplicas de una
// misma configuración de cómputo (droplet actual, o un ECS task definition futuro) son
// idénticas entre sí, así que no hace falta registrar de qué instancia física vino cada
// request: alcanza con saber qué config estaba vigente cuando se ejecutó. Usado para convertir
// CPU-tiempo medido por request (ver usageEvents.cpuTimeMicros) en costo real: (cpuTimeMicros /
// (cores * duración_del_período_en_micros)) * costPerMonth, prorrateado al período medido.
export const infraCostConfig = pgTable('infra_cost_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  cores: integer('cores').notNull(),
  costPerMonth: numeric('cost_per_month').notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
})

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
