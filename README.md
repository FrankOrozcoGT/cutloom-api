# CutLoom API

Backend de CutLoom — un editor de video web open source. La mayor parte del procesamiento de video ocurre en el cliente ([cutloom-web](https://github.com/FrankOrozcoGT/cutloom-web), vía WebCodecs + Whisper en el navegador); este servicio cubre lo que no puede vivir ahí.

## Responsabilidades

- Autenticación de usuarios y persistencia de proyectos (PostgreSQL).
- Integración OAuth y publicación directa a **YouTube** y **TikTok** vía sus APIs oficiales.
- Feature premium: **detección de emociones para sugerir shorts** dentro de un video largo.

## Pipeline de detección de shorts (premium)

1. **Whisper** (client-side, en [cutloom-web](https://github.com/FrankOrozcoGT/cutloom-web)) transcribe el video completo — gratis, sin tocar este backend.
2. La transcripción se envía a un **LLM (Kimi)** que identifica los tramos de texto con mayor potencial (ganchos, remates, cambios de ritmo) — filtra de 30 min a unos pocos minutos de candidatos.
3. Solo sobre esos tramos acotados corre **SenseVoice** (vía sherpa-onnx, en este servidor) para detectar emoción en el audio y afinar la selección final.

Este diseño en cascada evita correr el modelo de emoción sobre el video completo, manteniendo el costo de cómputo bajo en un droplet compartido.

## Stack

- Node.js (runtime a definir: Bun o Node según pruebas de compatibilidad con SenseVoice/sherpa-onnx).
- TypeScript.
- PostgreSQL.
- Cola de jobs con concurrencia limitada para el pipeline de emoción (evita saturar CPU compartida).

## Licencia

Apache License 2.0 — ver [LICENSE](./LICENSE).
