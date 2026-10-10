import { EventEmitter } from 'node:events'
import type { Notification, NotificationType } from '../../domain/entities/Notification'
import type { NotificationPublisher } from '../../domain/ports/NotificationPublisher'

/**
 * Pub/sub en memoria, un solo proceso — coherente con Bun.cron (los crons de reconciliación ya
 * asumen un único proceso Node/Bun corriendo el server, ver server.ts). Si el backend alguna
 * vez escala a múltiples instancias, esto necesita moverse a un broker real (Redis pub/sub) —
 * hoy sería sobre-ingeniería: un cliente conectado a una instancia nunca recibiría el evento
 * emitido en otra, pero de todas formas puede refrescar via GET /api/notifications al reconectar.
 */
export class InMemoryNotificationPublisher implements NotificationPublisher {
  private readonly emitter = new EventEmitter()

  constructor() {
    // Cada organización puede tener varios clientes SSE conectados simultáneamente (varias
    // pestañas, varios miembros) — sin este límite alto, Node loguea un warning de posible
    // memory leak a partir de 10 listeners por evento.
    this.emitter.setMaxListeners(1000)
  }

  publish(notification: Notification<NotificationType>): void {
    this.emitter.emit(notification.organizationId, notification)
  }

  subscribe(organizationId: string, onNotification: (notification: Notification<NotificationType>) => void): () => void {
    this.emitter.on(organizationId, onNotification)
    return () => this.emitter.off(organizationId, onNotification)
  }
}
