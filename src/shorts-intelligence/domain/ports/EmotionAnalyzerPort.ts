export interface EmotionAnalysisResult {
  /** Categoría cruda devuelta por sherpa-onnx/SenseVoice (ej. "HAPPY", "NEUTRAL", "ANGRY"). Sin score numérico: el modelo no expone confianza de la clasificación de emoción. */
  emotion: string
}

/** Puerto para el análisis de emoción de un tramo de audio (implementado por SenseVoiceProvider). */
export interface EmotionAnalyzerPort {
  analyze(audioBase64: string): Promise<EmotionAnalysisResult>
}
