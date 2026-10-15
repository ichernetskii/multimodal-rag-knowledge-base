# Server-only dependency graph. The client runtime and assets never enter this image.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN YARN_ENABLE_IMMUTABLE_INSTALLS=true node .yarn/releases/yarn-4.18.1.cjs workspaces focus @local-rag/server
COPY server/src server/src
COPY server/scripts server/scripts
COPY server/tsconfig*.json server/
RUN node .yarn/releases/yarn-4.18.1.cjs workspace @local-rag/server build

FROM build AS dependencies
RUN YARN_ENABLE_IMMUTABLE_INSTALLS=true node .yarn/releases/yarn-4.18.1.cjs workspaces focus @local-rag/server --production && mkdir -p server/node_modules

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ENV NODE_ENV=production RAG_HOST=0.0.0.0 RAG_PORT=3210 \
    RAG_DATA_DIR=/var/lib/local-rag RAG_BACKUP_DIR=/var/backups/local-rag \
    EMBEDDING_CACHE=/var/cache/local-rag/models \
    PDF_PYTHON=/opt/pdf/bin/python3 OLLAMA_URL=http://host.docker.internal:11434
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv tesseract-ocr tesseract-ocr-eng tesseract-ocr-rus \
    && rm -rf /var/lib/apt/lists/*
COPY server/requirements-pdf.txt /tmp/requirements-pdf.txt
RUN python3 -m venv /opt/pdf && /opt/pdf/bin/pip install --no-cache-dir -r /tmp/requirements-pdf.txt && rm /tmp/requirements-pdf.txt
COPY --from=dependencies /app/node_modules node_modules
COPY --from=dependencies /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY server/package.json server/package.json
COPY server/scripts/extract-pdf.py server/scripts/extract-pdf.py
COPY package.json package.json
RUN mkdir -p /var/lib/local-rag /var/backups/local-rag /var/cache/local-rag/models \
    && chown -R node:node /var/lib/local-rag /var/backups/local-rag /var/cache/local-rag
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3210/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/interfaces/cli/main.js", "serve"]
