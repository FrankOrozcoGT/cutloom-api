import { index, integer, jsonb, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { organizations } from '../../../identity/infrastructure/db/schema'
import { features } from '../../../shared/infrastructure/db/schema'
import type { UsageEventAction } from '../../../shared/domain/entities/UsageEventAction'
import type { Feature } from '../../../shared/domain/entities/Feature'
import type { UsageEventMetadata } from '../../domain/ports/UsageEventRepository'

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // Acción granular (telemetría de costo) — texto libre en vez de pgEnum: agregar una acción
    // nueva es un cambio de código (UsageEventAction), nunca una migración ALTER TYPE.
    action: text('action').notNull().$type<UsageEventAction>(),
    // Paquete facturable al que pertenece la acción (ver FEATURE_BY_USAGE_EVENT_ACTION) — FK
    // real a shared.features, igual patrón que billing.plan_features/entitlements.
    featureId: text('feature_id')
      .notNull()
      .references(() => features.id, { onDelete: 'restrict' })
      .$type<Feature>(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    // null cuando el costo estimado no se pudo calcular (precio/modelo aún sin configurar) — no bloquea el registro del evento.
    cost: real('cost'),
    // $type<T>() tipa la columna jsonb con el schema de Drizzle mismo — sin esto,
    // cualquier lectura de esta columna requeriría castear manualmente en cada archivo.
    metadata: jsonb('metadata').$type<UsageEventMetadata>().notNull(),
    // Cómputo local (ej. SenseVoice) en vez de LLM externo: CPU-tiempo real consumido
    // (process.cpuUsage, user+system, microsegundos) y memoria pico (maxRSS, bytes) — null
    // para eventos de LLM puro, donde el costo real ya viene de promptTokens/completionTokens.
    cpuTimeMicros: integer('cpu_time_micros'),
    peakMemoryBytes: integer('peak_memory_bytes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('usage_events_organization_id_idx').on(table.organizationId)],
)
