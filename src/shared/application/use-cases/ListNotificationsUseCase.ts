import type { Notification } from '../../domain/entities/Notification'
import type { NotificationRepository } from '../../domain/ports/NotificationRepository'

const DEFAULT_LIMIT = 50

export interface ListNotificationsInput {
  organizationId: string
  onlyUnread: boolean
}

export class ListNotificationsUseCase {
  constructor(private readonly notificationRepository: NotificationRepository) {}

  async execute(input: ListNotificationsInput): Promise<{ notifications: Notification[]; unreadCount: number }> {
    const [notifications, unreadCount] = await Promise.all([
      this.notificationRepository.findByOrganizationId(input.organizationId, { onlyUnread: input.onlyUnread, limit: DEFAULT_LIMIT }),
      this.notificationRepository.countUnread(input.organizationId),
    ])
    return { notifications, unreadCount }
  }
}
