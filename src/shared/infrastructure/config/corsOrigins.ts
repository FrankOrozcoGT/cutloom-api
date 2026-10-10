/** Único punto de verdad para los orígenes permitidos — usado tanto por el plugin @fastify/cors global como por cualquier servidor que maneje su propio CORS por fuera de Fastify (ver TusBulkUploadHandler, que @tus/server resuelve internamente sin pasar por el plugin). */
export function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS
  if (!raw) {
    return ['http://localhost:5173']
  }
  return raw.split(',').map((origin) => origin.trim())
}
