import type { NotificationRepository } from '../../domain/ports/NotificationRepository'

export class MarkNotificationReadUseCase {
  constructor(private readonly notificationRepository: NotificationRepository) {}

  /** id === null marca todas las notificaciones de la organización como leídas. */
  async execute(organizationId: string, id: string | null): Promise<void> {
    if (id === null) {
      return this.notificationRepository.markAllRead(organizationId)
    }
    return this.notificationRepository.markRead(organizationId, id)
  }
}
