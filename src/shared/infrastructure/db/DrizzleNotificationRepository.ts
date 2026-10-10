import { and, count, desc, eq } from 'drizzle-orm'
import type { Database } from './client'
import { notifications } from './schema'
import { Notification, type NotificationType } from '../../domain/entities/Notification'
import type { CreateNotificationInput, NotificationRepository } from '../../domain/ports/NotificationRepository'

function toEntity(row: typeof notifications.$inferSelect): Notification {
  return Notification.create({
    id: row.id,
    organizationId: row.organizationId,
    type: row.type,
    // El shape real de `data` está determinado por `type` (ver NotificationData) — jsonb no
    // preserva ese vínculo en tiempo de compilación, así que se recastea acá, el único punto
    // de la infraestructura que cruza esa frontera.
    data: row.data as Notification['data'],
    read: row.read,
    createdAt: row.createdAt,
  })
}

export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Database) {}

  async create<T extends NotificationType>(input: CreateNotificationInput<T>): Promise<Notification<T>> {
    const [row] = await this.db
      .insert(notifications)
      .values({ organizationId: input.organizationId, type: input.type, data: input.data })
      .returning()

    if (!row) throw new Error('Failed to create notification')
    return toEntity(row) as Notification<T>
  }

  async findByOrganizationId(organizationId: string, options: { onlyUnread: boolean; limit: number }): Promise<Notification[]> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(
        options.onlyUnread
          ? and(eq(notifications.organizationId, organizationId), eq(notifications.read, false))
          : eq(notifications.organizationId, organizationId),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(options.limit)

    return rows.map(toEntity)
  }

  async countUnread(organizationId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(notifications)
      .where(and(eq(notifications.organizationId, organizationId), eq(notifications.read, false)))

    return row?.value ?? 0
  }

  async markRead(organizationId: string, id: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.organizationId, organizationId), eq(notifications.id, id)))
  }

  async markAllRead(organizationId: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.organizationId, organizationId), eq(notifications.read, false)))
  }
}
