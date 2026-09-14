import { YouTubeVideoType } from '../../domain/entities/YouTubeVideo'
import type { YouTubeVideo } from '../../domain/entities/YouTubeVideo'

/** Techo total de piezas (largos + shorts) que el canal admite por semana — ver investigación de cadencia 3-5/semana. */
const WEEKLY_SLOT_CAP = 5
/** Fase fuerte de una serie nueva: capitaliza el interés fresco del video largo con los shorts de mejor score. */
const STRONG_PHASE_RATIO = 2 / 3
const MS_PER_DAY = 24 * 60 * 60 * 1000
/** Primer short recién a partir de este día tras el video largo — ver investigación de repurposing (7-14 días). */
const FIRST_SHORT_LATENCY_DAYS = 7

export const SlotTimeWindow = {
  /** 11:00-14:00 hora local — franja "mediodía", válida para largos y shorts (ver investigación Latam/YouTube). */
  Midday: { startHour: 11, endHour: 14 },
  /** 18:00-21:00 hora local — franja "noche", válida solo para shorts. */
  Evening: { startHour: 18, endHour: 21 },
} as const
export type SlotTimeWindow = (typeof SlotTimeWindow)[keyof typeof SlotTimeWindow]

export interface ScheduleSlotItem {
  sourceId: string
  videoType: YouTubeVideoType
  /**
   * Prioridad relativa (0-1) que decide el orden dentro de la fase fuerte/débil — mayor
   * prioridad va primero. Concepto propio de publishing, sin conocer de dónde sale el valor
   * (el caller es responsable de traducir cualquier señal externa, ej. el score de
   * shorts-intelligence, a esta prioridad antes de llamar a este servicio). Ignorado para el largo.
   */
  priority: number | null
}

export interface ScheduleUploadPlanInput {
  organizationId: string
  /** Huso horario IANA del público objetivo (ej. "America/Guatemala") — las franjas horarias se aplican en esta zona. */
  timeZone: string
  /** Día calendario propuesto para el video largo — el servicio lo puede correr hacia adelante si no hay hueco para el primer short. */
  longVideoPublishDay: Date
  items: ScheduleSlotItem[]
}

export interface ScheduledSlot {
  sourceId: string
  publishAt: Date
}

/** El calendario de la organización está saturado más allá de lo que este servicio puede resolver buscando hacia adelante (52 semanas para el largo, 365 días para un short) — nunca debe violarse WEEKLY_SLOT_CAP en silencio devolviendo el último candidato probado. */
export class ScheduleCapacityExceededError extends Error {
  constructor() {
    super('Could not find a free slot within the search window without exceeding the weekly cap')
    this.name = 'ScheduleCapacityExceededError'
  }
}

/**
 * Calendariza una serie nueva (1 largo + N shorts) contra la cola compartida de la
 * organización — no calcula en el vacío por serie, respeta lo que otras series ya tengan
 * programado (status Scheduled, publishAt futuro) para intercalar sin saturar el techo
 * semanal del canal. Determinístico, sin LLM — ver navegación de investigación de
 * calendarización para el razonamiento detrás de cada regla.
 */
export class ScheduleUploadPlanService {
  plan(input: ScheduleUploadPlanInput, alreadyScheduled: YouTubeVideo[]): ScheduledSlot[] {
    const longItem = input.items.find((item) => item.videoType === YouTubeVideoType.Long)
    const shortItems = input.items
      .filter((item) => item.videoType === YouTubeVideoType.Short)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

    const occupiedWeeks = this.occupiedSlotsByWeek(alreadyScheduled, input.timeZone)

    const longDay = longItem
      ? this.resolveLongVideoDay(input.longVideoPublishDay, occupiedWeeks, shortItems.length > 0, input.timeZone)
      : null

    const slots: ScheduledSlot[] = []
    if (longItem && longDay) {
      slots.push({
        sourceId: longItem.sourceId,
        publishAt: this.resolveDateTime(longDay, SlotTimeWindow.Midday, input.timeZone),
      })
      this.markWeekOccupied(occupiedWeeks, longDay, input.timeZone)
    }

    const shortsStartDay = this.addDays(longDay ?? input.longVideoPublishDay, FIRST_SHORT_LATENCY_DAYS)
    const strongPhaseCount = shortItems.length > 0 ? Math.ceil(WEEKLY_SLOT_CAP * STRONG_PHASE_RATIO) : 0

    let cursor = shortsStartDay
    for (let i = 0; i < shortItems.length; i++) {
      const item = shortItems[i]!
      const weeklyBudget = i < strongPhaseCount ? strongPhaseCount : WEEKLY_SLOT_CAP - strongPhaseCount
      cursor = this.nextFreeDay(cursor, occupiedWeeks, weeklyBudget, input.timeZone)

      // Alterna franja mediodía/noche para variar el patrón, no publicar siempre a la misma
      // hora. No se aplica jitter también sobre el día (solo sobre la hora, ver
      // resolveDateTime): correr el día arriesgaría colisionar con un slot ya ocupado de otra
      // serie, y el jitter horario ya rompe el patrón robótico sin ese riesgo.
      const window = i % 2 === 0 ? SlotTimeWindow.Evening : SlotTimeWindow.Midday
      slots.push({ sourceId: item.sourceId, publishAt: this.resolveDateTime(cursor, window, input.timeZone) })
      this.markWeekOccupied(occupiedWeeks, cursor, input.timeZone)
      cursor = this.addDays(cursor, 1)
    }

    return slots
  }

  private resolveLongVideoDay(
    candidate: Date,
    occupiedWeeks: Map<number, number>,
    hasShorts: boolean,
    timeZone: string,
  ): Date {
    if (!hasShorts) return candidate

    // No se confirma el largo si el primer short (el de mayor prioridad, el más importante de
    // la serie) no tendría hueco 7 días después — se corre el largo hacia adelante hasta que sí.
    let candidateDay = candidate
    for (let attempts = 0; attempts < 52; attempts++) {
      const firstShortDay = this.addDays(candidateDay, FIRST_SHORT_LATENCY_DAYS)
      const used = occupiedWeeks.get(this.weekNumber(firstShortDay, timeZone)) ?? 0
      if (used < WEEKLY_SLOT_CAP) return candidateDay
      candidateDay = this.addDays(candidateDay, 7)
    }
    // Agotar la ventana de búsqueda (52 semanas) sin encontrar hueco significa que el
    // calendario está saturado de forma anómala — nunca se devuelve un día que violaría
    // WEEKLY_SLOT_CAP en silencio.
    throw new ScheduleCapacityExceededError()
  }

  private nextFreeDay(from: Date, occupiedWeeks: Map<number, number>, weeklyBudget: number, timeZone: string): Date {
    let cursor = from
    for (let attempts = 0; attempts < 365; attempts++) {
      const used = occupiedWeeks.get(this.weekNumber(cursor, timeZone)) ?? 0
      if (used < weeklyBudget) return cursor
      cursor = this.addDays(cursor, 1)
    }
    throw new ScheduleCapacityExceededError()
  }

  private occupiedSlotsByWeek(alreadyScheduled: YouTubeVideo[], timeZone: string): Map<number, number> {
    const map = new Map<number, number>()
    for (const video of alreadyScheduled) {
      // publishAt es null en publicación inmediata (Uploading/Uploaded) — esa pieza ya ocupó
      // su slot en la semana en la que efectivamente se subió, no en una fecha futura.
      const referenceDate = video.publishAt ?? video.createdAt
      const week = this.weekNumber(referenceDate, timeZone)
      map.set(week, (map.get(week) ?? 0) + 1)
    }
    return map
  }

  private markWeekOccupied(occupiedWeeks: Map<number, number>, day: Date, timeZone: string): void {
    const week = this.weekNumber(day, timeZone)
    occupiedWeeks.set(week, (occupiedWeeks.get(week) ?? 0) + 1)
  }

  /**
   * Número de semana calculado sobre la fecha CIVIL en timeZone (no el epoch UTC crudo) —
   * dos instantes que caen en distinto día UTC pero en el mismo día/semana civil local
   * (ej. domingo 8pm en Guatemala = lunes 2am UTC) deben contar como la misma semana, que es
   * el concepto de "semana" que el usuario percibe en su propio calendario.
   */
  private weekNumber(date: Date, timeZone: string): number {
    const { year, month, dayOfMonth } = this.civilDatePartsInZone(date, timeZone)
    const civilDayEpoch = Date.UTC(year, month - 1, dayOfMonth) / MS_PER_DAY
    return Math.floor(civilDayEpoch / 7)
  }

  private addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * MS_PER_DAY)
  }

  /**
   * Construye el instante final combinando el día calendario + una hora aleatoria dentro de
   * la franja horaria, ya interpretados en el huso horario del público — no un jitter ciego
   * sobre un Date sin zona, que podría empujar la hora fuera de la franja o cruzar de día.
   */
  private resolveDateTime(day: Date, window: SlotTimeWindow, timeZone: string): Date {
    const { year, month, dayOfMonth } = this.civilDatePartsInZone(day, timeZone)
    const windowMinutes = (window.endHour - window.startHour) * 60
    const offsetMinutes = Math.random() * windowMinutes
    const totalMinutesFromMidnight = window.startHour * 60 + offsetMinutes

    const hour = Math.floor(totalMinutesFromMidnight / 60)
    const minute = Math.floor(totalMinutesFromMidnight % 60)

    return this.zonedDateTimeToUtc(year, month, dayOfMonth, hour, minute, timeZone)
  }

  private civilDatePartsInZone(date: Date, timeZone: string): { year: number; month: number; dayOfMonth: number } {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const year = Number(parts.find((p) => p.type === 'year')!.value)
    const month = Number(parts.find((p) => p.type === 'month')!.value)
    const dayOfMonth = Number(parts.find((p) => p.type === 'day')!.value)
    return { year, month, dayOfMonth }
  }

  /** Convierte una hora civil (año/mes/día/hora/min) en el huso indicado a un instante UTC real, corrigiendo el offset detectado. */
  private zonedDateTimeToUtc(
    year: number,
    month: number,
    dayOfMonth: number,
    hour: number,
    minute: number,
    timeZone: string,
  ): Date {
    // Primera aproximación: tratar los componentes civiles como si fueran UTC.
    const naiveUtc = Date.UTC(year, month - 1, dayOfMonth, hour, minute)
    const offsetMs = this.tzOffsetMs(new Date(naiveUtc), timeZone)
    return new Date(naiveUtc - offsetMs)
  }

  /** Diferencia entre UTC y la hora civil que ese instante representa en timeZone. */
  private tzOffsetMs(date: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value)
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    return asUtc - date.getTime()
  }
}
