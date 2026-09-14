interface TimeRange {
  start: number
  end: number
}

/** Minutos de contenido cubiertos por un conjunto de rangos [start,end] en segundos, redondeados hacia arriba — unidad real de facturación para features que procesan video/audio (a diferencia de youtube_ai, que no tiene duración asociada). */
export function totalMinutes(ranges: TimeRange[]): number {
  if (ranges.length === 0) return 0
  const totalSeconds = ranges.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0)
  return Math.max(1, Math.ceil(totalSeconds / 60))
}
