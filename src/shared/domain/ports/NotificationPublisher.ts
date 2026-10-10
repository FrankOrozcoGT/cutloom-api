import type { Notification, NotificationType } from '../entities/Notification'

/**
 * Push en tiempo real de una notificación ya persistida hacia cualquier cliente SSE conectado
 * de esa organización — separado de NotificationRepository porque persistencia y entrega son
 * responsabilidades distintas (una notificación se persiste siempre; el push solo llega si hay
 * alguien conectado en ese instante, el cliente igual la ve al cargar /api/notifications).
 */
export interface NotificationPublisher {
  publish(notification: Notification<NotificationType>): void
  /** Devuelve una función de unsubscribe — el caller (endpoint SSE) debe invocarla cuando el cliente se desconecta, para no acumular listeners fantasma. */
  subscribe(organizationId: string, onNotification: (notification: Notification<NotificationType>) => void): () => void
}
