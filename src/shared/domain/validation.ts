/** Único punto de verdad para este type guard — usado en el borde de cualquier parser que valide un dato externo (ver criterio de tipado en code_review). Vive en shared/domain (no infrastructure) para que entidades de dominio puedan importarlo sin cruzar capas. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
