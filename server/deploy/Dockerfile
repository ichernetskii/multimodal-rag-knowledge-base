FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS dependencies
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN YARN_ENABLE_IMMUTABLE_INSTALLS=true node .yarn/releases/yarn-4.18.1.cjs workspaces focus @local-rag/server
FROM dependencies AS build
COPY server/src server/src
COPY tooling/server tooling/server
COPY server/tsconfig*.json server/
RUN node .yarn/releases/yarn-4.18.1.cjs workspace @local-rag/server build
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS media-build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates cmake g++ make pkg-config zlib1g-dev && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/server/dist/config/paths.js /app/server/dist/config/media-runtime.js server/dist/config/
COPY --from=build /app/server/dist/infrastructure/media-runtime server/dist/infrastructure/media-runtime
ENV MEDIA_RUNTIME_DIR=/opt/local-rag/media CMAKE_BIN=cmake MEDIA_BUILD_THREADS=2
RUN node --input-type=module -e "import {prepareMediaRuntime} from './server/dist/infrastructure/media-runtime/installer.js';await prepareMediaRuntime()"
FROM dependencies AS production-dependencies
RUN YARN_ENABLE_IMMUTABLE_INSTALLS=true node .yarn/releases/yarn-4.18.1.cjs workspaces focus @local-rag/server --production && mkdir -p server/node_modules
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ENV NODE_ENV=production RAG_HOST=0.0.0.0 RAG_PORT=3210 RAG_TEMP_DIR=/tmp/local-rag MEDIA_RUNTIME_DIR=/opt/local-rag/media PDF_PYTHON=/opt/pdf/bin/python3 OLLAMA_URL=http://ollama:11434
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv tesseract-ocr tesseract-ocr-eng tesseract-ocr-rus && rm -rf /var/lib/apt/lists/*
COPY server/requirements-pdf.txt /tmp/requirements-pdf.txt
RUN python3 -m venv /opt/pdf && /opt/pdf/bin/pip install --no-cache-dir -r /tmp/requirements-pdf.txt && rm /tmp/requirements-pdf.txt
COPY --from=production-dependencies /app/node_modules node_modules
COPY --from=production-dependencies /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --chown=node:node --from=media-build /opt/local-rag/media /opt/local-rag/media
COPY --chown=node:node --from=media-build /app/server/.cache/whisper server/.cache/whisper
COPY server/package.json server/package.json
COPY server/resources server/resources
COPY package.json package.json
USER node
EXPOSE 3210
CMD ["node", "server/dist/interfaces/cli/main.js", "serve"]
