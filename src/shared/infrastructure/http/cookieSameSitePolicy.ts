// Cross-site cookies en dev
//
// Pruebas locales con túnel (frontend en localhost:5173, backend expuesto vía Cloudflare
// Tunnel) son cross-site real para el navegador — 'strict'/'lax' bloquean el Set-Cookie
// (confirmado con el mensaje exacto de Chrome DevTools al debuggear el login de TikTok/Google).
// En producción frontend y backend comparten site real, así que ahí sí corresponde el valor
// estricto normal. Un solo punto de verdad en vez de 4 copias de este mismo if/else
// (AuthController, sseAuthMiddleware, PlatformOAuthController) que podían quedar
// desincronizadas entre sí.
const isProduction = process.env.NODE_ENV === 'production'

/** Para cookies que solo viajan en requests same-origin normales del propio frontend (ej. refreshToken). */
export const strictSameSite = isProduction ? ('strict' as const) : ('none' as const)

/** Para cookies seteadas en respuesta a un fetch cross-site o una navegación top-level cross-site (ej. state de OAuth, SSE). */
export const laxSameSite = isProduction ? ('lax' as const) : ('none' as const)

/** sameSite 'none' (dev) exige Secure=true obligatorio, y 'strict'/'lax' (producción) también
 * corren sobre HTTPS real — por eso es simplemente true en ambos casos, nunca condicional. */
export const secureCookie = true
