export interface AudioClipInput {
  start: number
  end: number
  audioBase64: string
}

/**
 * El audio de cada tramo llega ya recortado en base64 desde el frontend (los
 * videos viven en cutloom-web) — este puerto solo asocia el tramo detectado
 * por DeepSeek con el clip de audio correspondiente enviado por el cliente.
 */
export interface ShortAudioSource {
  findClipForRange(start: number, end: number): AudioClipInput | undefined
}
