# Knowledge Workspace SaaS

Multi-tenant knowledge application: React client and administration, Node.js API and workers, PostgreSQL with pgvector/RLS, pg-boss durable queues, private local S3 (SeaweedFS), Redis cache. AI providers are replaceable profiles: Google, Anthropic, Ollama, OpenAI-compatible endpoints and local whisper.cpp.

Unreleased, incompatible schema version 7. No legacy import or API compatibility. Development uses an explicitly labelled deterministic TEST AI; it is not evidence of model answer quality.

## Develop

Install Node.js 24.19+ and Docker Desktop / Docker Engine with Compose v2. Then:

```sh
yarn install --immutable
yarn configure
yarn infra:up
yarn cli init
yarn seed
yarn dev
```

Open http://localhost:5173. Development account: `admin` / `local-development-only`. The seed is prohibited in production. API and workers reload with server changes; Vite provides client HMR. Infrastructure remains in Docker.

Try the [multimodal knowledge-base corpus](examples/knowledge-base/README.md): Markdown/text, four PDF cases, an image, speech and a ready-to-upload video. After CLI login/company selection, `yarn demo:import` uploads a new review-only knowledge base through the public API. Publish after reviewing the extracted material. TEST AI checks infrastructure; use real configured models to evaluate answers.

## Entire application in Docker

```sh
yarn docker:up
docker compose --env-file .env -p local-rag-saas-app --profile app exec -T api node server/dist/interfaces/cli/main.js seed
```

Open http://localhost:8080. This is a separate installation from native development. Production uses `yarn configure --production`, a real HTTPS domain, an operator created with `bootstrap`, provider credentials and prices; see the [operations guide](docs/OPERATIONS.md).

[Русское руководство](README.ru.md) · [Documentation](docs/README.md) · [Architecture](docs/ARCHITECTURE.md) · [Development](docs/DEVELOPMENT.md) · [Verification](docs/VERIFICATION.md)

Source layout: `client/src` for browser code, `server/src` for API/workers/CLI, `server/resources` for PDF/OCR runtime helpers, `tooling` for development commands, `examples` for reusable sample data, `deploy`/Compose for deployment. Generated evidence belongs in ignored `.artifacts/`, curated reports in `docs/verification/`. The [admin redesign specification](docs/ADMIN-UX.md) describes the interactive prototype for future implementation; the current UI is documented in [usage](docs/USAGE.md).

For a new local-AI installation, use `yarn configure --local-ai` followed by `yarn docker:up` and the container seed command in [development](docs/DEVELOPMENT.md). The optional Docker overlay downloads Qwen3.5:4b and EmbeddingGemma into a persistent Ollama volume; Whisper small is bundled in the server image. Model availability is checked from the server in the admin UI and with `yarn cli models status`. See [operations](docs/OPERATIONS.md) for moving data, secrets and model volumes.
