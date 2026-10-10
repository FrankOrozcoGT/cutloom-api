import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ListNotificationsUseCase } from '../../application/use-cases/ListNotificationsUseCase'
import type { MarkNotificationReadUseCase } from '../../application/use-cases/MarkNotificationReadUseCase'
import type { NotificationPublisher } from '../../domain/ports/NotificationPublisher'
import type { Notification, NotificationType } from '../../domain/entities/Notification'

const HEARTBEAT_INTERVAL_MS = 25_000

function serializeNotification(n: Notification<NotificationType>) {
  return { id: n.id, type: n.type, data: n.data, read: n.read, createdAt: n.createdAt.toISOString() }
}

export class NotificationController {
  constructor(
    private readonly listNotificationsUseCase: ListNotificationsUseCase,
    private readonly markNotificationReadUseCase: MarkNotificationReadUseCase,
    private readonly notificationPublisher: NotificationPublisher,
    private readonly corsOrigins: string[],
  ) {}

  async list(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }
    const { onlyUnread } = req.query as { onlyUnread?: string }
    const result = await this.listNotificationsUseCase.execute({
      organizationId: req.organizationId,
      onlyUnread: onlyUnread === 'true',
    })
    return reply.status(200).send({
      notifications: result.notifications.map(serializeNotification),
      unreadCount: result.unreadCount,
    })
  }

  /** :id === "all" marca todas como leídas — evita un segundo endpoint solo para ese caso. */
  async markRead(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }
    const { id } = req.params as { id: string }
    await this.markNotificationReadUseCase.execute(req.organizationId, id === 'all' ? null : id)
    return reply.status(204).send()
  }

  /**
   * SSE (EventSource) — push en tiempo real de notificaciones nuevas para la organización
   * autenticada (ver sseAuthMiddleware). Fastify no tiene soporte nativo de SSE: se escribe
   * directo sobre el ServerResponse crudo (reply.raw) con los headers del protocolo
   * (text/event-stream, sin buffering de proxies vía Cache-Control/Connection). Un heartbeat
   * periódico evita que proxies/balanceadores intermedios corten la conexión por inactividad,
   * y no filtra datos: es un comentario SSE (`:`), que EventSource descarta sin disparar
   * ningún evento en el cliente.
   */
  async stream(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }
    const organizationId = req.organizationId

    // reply.raw.writeHead salta el ciclo normal de Fastify (reply.send/reply.header), donde
    // @fastify/cors inyecta Access-Control-Allow-Origin — sin esto el navegador bloquea la
    // respuesta del EventSource con MissingAllowOriginHeader. Se refleja el origin del
    // request (no '*': la conexión usa credentials vía cookie, ver sseAuthMiddleware).
    const origin = req.headers.origin
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    }
    if (origin && this.corsOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin
      headers['Access-Control-Allow-Credentials'] = 'true'
      headers.Vary = 'Origin'
    }
    reply.raw.writeHead(200, headers)
    // Confirma la conexión abierta de inmediato — sin esto, el cliente EventSource no dispara
    // 'open' hasta el primer evento real, que puede tardar mucho en llegar.
    reply.raw.write(':ok\n\n')

    const send = (notification: Notification<NotificationType>) => {
      if (notification.organizationId !== organizationId) return
      reply.raw.write(`event: notification\ndata: ${JSON.stringify(serializeNotification(notification))}\n\n`)
    }
    const unsubscribe = this.notificationPublisher.subscribe(organizationId, send)

    const heartbeat = setInterval(() => reply.raw.write(':heartbeat\n\n'), HEARTBEAT_INTERVAL_MS)

    req.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  }
}
