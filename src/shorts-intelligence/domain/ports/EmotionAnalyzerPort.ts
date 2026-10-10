export interface EmotionAnalysisResult {
  /**
   * Categoría cruda devuelta por sherpa-onnx/SenseVoice (ej. "HAPPY", "NEUTRAL", "ANGRY").
   * undefined = el modelo no logró clasificar la emoción con confianza suficiente
   * (categoría EMO_UNKNOWN de SenseVoice, filtrada en el provider) — se trata igual que
   * un análisis sin emoción disponible, no como una categoría emocional real.
   * Sin score numérico: el modelo no expone confianza de la clasificación de emoción.
   */
  emotion: string | undefined
  /** CPU-tiempo real consumido por este análisis puntual (ver SenseVoiceProcessManager) —
   * usado para calcular el costo real de cómputo local contra infraCostConfig. undefined si
   * el provider no lo mide (no todos los EmotionAnalyzerPort corren cómputo local medible). */
  cpuTimeMicros?: number
  peakMemoryBytes?: number
}

/** Puerto para el análisis de emoción de un tramo de audio (implementado por SenseVoiceProvider). */
export interface EmotionAnalyzerPort {
  analyze(audioBuffer: Buffer): Promise<EmotionAnalysisResult>
}
