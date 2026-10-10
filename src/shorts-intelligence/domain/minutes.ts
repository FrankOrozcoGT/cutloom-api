interface TimeRange {
  start: number
  end: number
}

/** Minutos de contenido cubiertos por un conjunto de rangos [start,end] en MILISEGUNDOS
 * (confirmado contra el payload real del frontend — ver ImproveSubtitlesUseCase), redondeados
 * hacia arriba. */
export function totalMinutes(ranges: TimeRange[]): number {
  if (ranges.length === 0) return 0
  const totalMilliseconds = ranges.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0)
  return Math.max(1, Math.ceil(totalMilliseconds / 60_000))
}
