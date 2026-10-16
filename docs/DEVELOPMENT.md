# Разработка

Node.js 24.19+; Docker Desktop on macOS or Docker Engine with Compose v2 on Linux. Intel and ARM64 use native images; Apple M4 performance is not inferred from Intel checks. Yarn is pinned in the repository; `node .yarn/releases/yarn-4.18.1.cjs` works if the yarn shim is absent.

```sh
yarn install --immutable
yarn configure
yarn infra:up
yarn cli init
yarn seed
yarn dev
```

Open http://localhost:5173. The API binds loopback 3210; Vite proxies `/api` and `/health`. PostgreSQL 5432, Redis 6379 and S3 8333 bind loopback only in compose.dev.yaml. Production Compose exposes only Nginx. Avoid running two infrastructure projects on these same host ports.

The dev runner starts API, workers and Vite, supervises only its own processes, regenerates the public contract and reloads server TypeScript. `.run/Knowledge SaaS.run.xml` provides a shared WebStorm run configuration. Use the Node debugger against an individual `serve` or `worker` process when needed; keep one worker for deterministic debugging.

The root `.env` is private and generated once. Client contains no secrets. Native media preprocessing uses `yarn prepare:pdf` and `yarn prepare:media`; all tools and weights are bundled automatically for Docker. Cloud generation does not require a preinstalled local LLM.

Build/launch/PDF preparation entry points live in `tooling/server/`. Required Python and Swift runtime helpers live in `server/resources/extraction/`, including in production images; do not treat them as disposable scripts. `server/src` contains application code only. No `server/scripts` or duplicate `server/examples` directory is needed.

## Учебные данные

After `yarn dev`, sign in with `yarn cli login admin`, select the company with `yarn cli tenant-use COMPANY_UUID`, then run `yarn demo:import`. It creates a fresh knowledge base with nine materials, checks local checksums before uploading and waits for processing. Review/publish in the UI. `yarn demo:import --publish` explicitly acknowledges demo publication and may use the configured AI budget. See [corpus](../examples/knowledge-base/README.md) for every modality, expected answers, partial failures and repeat-run behavior. Seed itself creates no content. No automatic customer-data replacement occurs.

## Полностью Docker

```sh
yarn docker:up
docker compose --env-file .env -p local-rag-saas-app --profile app exec -T api node server/dist/interfaces/cli/main.js seed
```

Open http://localhost:8080. This project has separate volumes from native development. Rebuild source changes with `yarn docker:up`; use `yarn dev` for HMR. `.env` uses RAG_PUBLIC_ORIGIN for native dev, DOCKER_PUBLIC_ORIGIN for container ingress.

## Локальные модели в Docker

For a new installation run `yarn configure --local-ai` instead of `yarn configure`, then `yarn docker:up`. On the first run the optional compose.local-ai.yaml starts Ollama and downloads Qwen3.5:4b plus EmbeddingGemma. API/workers wait for that one-shot initializer. Repeated starts inspect and reuse existing models without registry access. Whisper, FFmpeg and Whisper small weights are already part of the server image.

For an existing private .env set LOCAL_AI=1 and choose the default providers described in [configuration](CONFIGURATION.md); keep existing secrets. Environment defaults apply only to newly created companies. Existing company profiles/settings and embedding index must be changed through the API/admin/CLI. The current local profiles use a 8192-token Qwen context and one parallel call. Docker on macOS runs these Linux models on CPU; it does not provide Metal acceleration.

The first image/model download needs Internet and several GB of disk. Startup can take much longer than a warm restart. Failed downloads stop the local initializer; `yarn docker:up` retries and Ollama resumes its partially downloaded files. Do not delete the ollama-data volume when restarting.

## Как проверять изменение

`yarn dev:reset --confirm-development-reset` removes only local-rag-saas-dev volumes. Then run init and seed again. A schema mismatch is deliberately rejected; there are no migrations for old data. Never substitute a production project name into a reset command.

`yarn test` runs bounded unit/component/resource tests, including corpus checksums/modality coverage. `yarn test:integration` requires running PostgreSQL/Redis/S3 from `yarn infra:up`, but no initialized application database. It creates a separate `rag_test_*` database and `rag-test-*` S3 bucket, applies the current schema, exercises real queues/RLS/storage/backup, document windows and corrections, then removes only those resources. The administrative PostgreSQL URL must be loopback. Existing development data and incompatible schemas are not modified. `yarn test:docker` creates a fresh rag-test-* installation, exercises the built images with PDF/OCR, image, audio and ready-made video inputs and deletes only its own volumes. It writes `.artifacts/verification/docker.json`; this output is ignored by Git and excluded from Docker. TEST AI is explicitly enabled in those scenarios; real provider quality requires configured models and manual evaluation against corpus questions.

## Команды package.json

- `yarn dev` — `node tooling/dev.ts`.
- `yarn dev:client` — `yarn workspace @local-rag/client dev`.
- `yarn dev:server` — `yarn workspace @local-rag/server dev`.
- `yarn cli` — `yarn workspace @local-rag/server cli`.
- `yarn build` — `yarn build:client && yarn build:server`.
- `yarn build:client` — `yarn workspace @local-rag/client build`.
- `yarn build:server` — `yarn workspace @local-rag/server build`.
- `yarn start` — `node tooling/start.ts`.
- `yarn typecheck` — `tsc --noEmit && tsc --noEmit -p tooling/testing/tsconfig.json && yarn workspace @local-rag/server typecheck && yarn workspace @local-rag/client typecheck`.
- `yarn lint` — `eslint .`.
- `yarn lint:fix` — `eslint . --fix`.
- `yarn format` — `prettier . --write`.
- `yarn format:check` — `prettier . --check`.
- `yarn test` — `yarn workspace @local-rag/server test && yarn workspace @local-rag/client test`.
- `yarn validate` — `yarn docs:check && yarn contracts:check && yarn typecheck && yarn lint && yarn format:check && yarn test && yarn build`.
- `yarn prepare:pdf` — `yarn workspace @local-rag/server prepare:pdf`.
- `yarn contracts:generate` — `node tooling/contracts.ts`.
- `yarn contracts:check` — `node tooling/contracts.ts --check`.
- `yarn docs:check` — `node tooling/check-docs.ts`.
- `yarn configure` — `node tooling/configure.ts`.
- `yarn start:server` — `yarn workspace @local-rag/server start`.
- `yarn start:client` — `yarn workspace @local-rag/client start`.
- `yarn prepare:media` — `yarn workspace @local-rag/server prepare:media`.
- `yarn test:docker` — `node tooling/test-docker.ts`.
- `yarn infra:up` — `node tooling/infra.ts up`.
- `yarn infra:down` — `node tooling/infra.ts down`.
- `yarn dev:reset` — `node tooling/infra.ts reset`.
- `yarn seed` — `yarn cli seed`.
- `yarn test:integration` — `node --import tsx tooling/testing/integration.ts`.
- `yarn docker:up` — `node tooling/infra.ts app`.
- `yarn docker:down` — `node tooling/infra.ts app-down`.
- `yarn installation:backup` — `node --import tsx tooling/installation.ts backup`.
- `yarn installation:restore` — `node --import tsx tooling/installation.ts restore`.
- `yarn demo:import` — `node --import tsx tooling/import-demo.ts`; new multimodal review-only knowledge base, optional `--publish`.

- `yarn test:workspace` — `node --import tsx tooling/testing/workspace.ts`.

## Проверка реального интерфейса

Run `yarn build:client`, then `yarn test:workspace`. The helper uses the same isolated database/bucket ownership rules, starts API/workers and the production client gateway on random loopback ports, imports all nine corpus materials plus a long TXT and a deliberately broken PDF, and prints the URL and disposable logins. Native PDF/OCR/media tools must be prepared first. Accounts include the platform operator, company administrator, editor and reader. AI generation/embeddings use TEST AI: this checks real HTTP/UI/permissions/jobs, not LLM quality. Whisper, PDF/OCR and video processing are real. Stop with Ctrl+C to close servers and remove the owned database/bucket. Temporary observations/screenshots belong in `.artifacts/verification/`.

`tooling/testing` runs explicitly through tsx and has a separate TypeScript project that checks imported server code. The root tooling project retains erasableSyntaxOnly for scripts executed directly by Node.
