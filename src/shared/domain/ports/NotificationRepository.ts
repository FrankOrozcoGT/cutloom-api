import type { Notification, NotificationData, NotificationType } from '../entities/Notification'

export interface CreateNotificationInput<T extends NotificationType = NotificationType> {
  organizationId: string
  type: T
  data: NotificationData[T]
}

export interface NotificationRepository {
  create<T extends NotificationType>(input: CreateNotificationInput<T>): Promise<Notification<T>>
  /** Más recientes primero — usado para la campanita del frontend. */
  findByOrganizationId(organizationId: string, options: { onlyUnread: boolean; limit: number }): Promise<Notification[]>
  countUnread(organizationId: string): Promise<number>
  /** Idempotente: marcar como leída una notificación ya leída (o de otra organización) no falla, simplemente no afecta filas. Scoped por organizationId para que una organización nunca pueda marcar notificaciones ajenas. */
  markRead(organizationId: string, id: string): Promise<void>
  markAllRead(organizationId: string): Promise<void>
}
