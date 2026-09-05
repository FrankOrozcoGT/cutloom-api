FROM oven/bun:1-debian AS base

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM base AS models
WORKDIR /models
RUN apt-get update && apt-get install -y --no-install-recommends curl bzip2 \
  && rm -rf /var/lib/apt/lists/*
# Paso oficial de descarga del modelo SenseVoice (sherpa-onnx nodejs-addon-examples/README.md).
RUN curl -SL -O https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2 \
  && tar xjf sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2 \
  && rm sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2

FROM base AS production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=models /models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17 /models/sense-voice
COPY . .

ENV LD_LIBRARY_PATH=/app/node_modules/sherpa-onnx-linux-x64
ENV SENSEVOICE_MODEL_PATH=/models/sense-voice/model.int8.onnx
ENV SENSEVOICE_TOKENS_PATH=/models/sense-voice/tokens.txt

EXPOSE 3000
CMD ["bun", "run", "start"]
