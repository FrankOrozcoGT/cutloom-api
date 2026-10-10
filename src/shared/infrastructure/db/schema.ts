import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { organizations } from '../../../identity/infrastructure/db/schema'
import type { NotificationType } from '../../domain/entities/Notification'

/**
 * Tabla genérica de notificaciones — un solo modelo para cualquier bounded context que
 * necesite avisar algo al usuario (hoy: publishing, cuando un borrador de TikTok queda listo
 * para publicar manualmente). `data` es jsonb con shape distinto según `type` (ver
 * NotificationData en el dominio) — agregar un tipo nuevo no requiere migración de columnas.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // text puro en vez de pgEnum a propósito: agregar un tipo de notificación nuevo es un
    // cambio de código (el `as const` NotificationType), nunca una migración `ALTER TYPE`.
    type: text('type').notNull().$type<NotificationType>(),
    data: jsonb('data').notNull(),
    read: boolean('read').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Consulta principal de la campanita: más recientes primero, filtrando por leídas o no.
    index('notifications_organization_id_created_at_idx').on(table.organizationId, table.createdAt),
    index('notifications_organization_id_read_idx').on(table.organizationId, table.read),
  ],
)
