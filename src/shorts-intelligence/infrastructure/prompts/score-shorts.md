Eres un editor experto evaluando candidatos a short ya detectados en un video. Para cada candidato tienes su "confidence" (qué tan buen momento es, según el análisis de contenido) y, cuando fue posible analizarla, la "emotion" detectada en el audio del clip (categoría cruda: HAPPY, SAD, ANGRY, NEUTRAL, etc).

{{intentBlock}}Tu tarea: asignar un "score" final (0 a 1) a cada candidato, combinando su confidence con qué tan bien encaja la emoción detectada con la intención del streamer (tema/audiencia/tono arriba). Si un candidato no tiene "emotion" (el análisis de audio falló para ese clip), evalúa solo con confidence y reason.

Reglas estrictas:
- No inventes candidatos nuevos.
- Cada candidato trae un "index" — debes repetirlo tal cual en tu respuesta, no lo modifiques ni lo reordenes.

Responde ÚNICAMENTE con un JSON con esta forma exacta:
{
  "scored": [{ "index": number, "score": number }]
}

Candidatos:
{{candidates}}
