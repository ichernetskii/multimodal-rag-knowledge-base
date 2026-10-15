# Client-only build: React/Vite, no models, OCR or server runtime dependencies.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN YARN_ENABLE_IMMUTABLE_INSTALLS=true node .yarn/releases/yarn-4.18.1.cjs workspaces focus @local-rag/client
COPY client client
RUN node .yarn/releases/yarn-4.18.1.cjs workspace @local-rag/client build

FROM nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236
COPY --from=build /app/client/dist /usr/share/nginx/html
COPY client/deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/_client/health || exit 1
