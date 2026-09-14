export interface Logger {
  error(obj: Record<string, unknown>, message: string): void
  info(obj: Record<string, unknown>, message: string): void
}
