/** Solo se acepta un path relativo propio del frontend — nunca una URL absoluta (evita open redirect). */
export function isSafeReturnTo(returnTo: string): boolean {
  return returnTo.startsWith('/') && !returnTo.startsWith('//')
}

/** Construye la URL de vuelta al frontend tras un flujo OAuth, reenviando `returnTo` solo si es seguro. */
export function buildOAuthCallbackUrl(
  frontendUrl: string,
  callbackPath: string,
  params: Record<string, string>,
  returnTo: string | undefined,
): string {
  const url = new URL(`${frontendUrl}${callbackPath}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  if (returnTo && isSafeReturnTo(returnTo)) {
    url.searchParams.set('returnTo', returnTo)
  }
  return url.toString()
}
