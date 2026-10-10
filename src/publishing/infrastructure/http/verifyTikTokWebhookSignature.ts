import { createHmac, timingSafeEqual } from 'node:crypto'

/** Extrae t= y s= del header "t=<timestamp>,s=<hmac-sha256-hex>" — null si falta alguno. */
function parseSignatureHeader(signatureHeader: string): { timestamp: string; signature: string } | null {
  let timestamp: string | undefined
  let signature: string | undefined
  for (const pair of signatureHeader.split(',')) {
    const [key, value] = pair.split('=')
    if (key === 't') timestamp = value
    if (key === 's') signature = value
  }
  if (!timestamp || !signature) return null
  return { timestamp, signature }
}

/**
 * Verifica el header TikTok-Signature contra el raw body — HMAC-SHA256 con
 * TIKTOK_CLIENT_SECRET como key sobre "{timestamp}.{body}", según la doc oficial de TikTok for
 * Developers (Webhooks Verification). El raw body (no el JSON reparseado) es obligatorio:
 * cualquier diferencia de serialización invalidaría la firma.
 */
export function verifyTikTokWebhookSignature(rawBody: string, signatureHeader: string, clientSecret: string): boolean {
  const parsed = parseSignatureHeader(signatureHeader)
  if (!parsed) return false

  const signedPayload = `${parsed.timestamp}.${rawBody}`
  const expectedSignature = createHmac('sha256', clientSecret).update(signedPayload).digest('hex')

  const expected = Buffer.from(expectedSignature)
  const received = Buffer.from(parsed.signature)
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}
