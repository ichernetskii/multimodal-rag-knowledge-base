# Проверки версии 7

`yarn validate` checks documentation/action/script/environment contracts, generated client/server contract, TypeScript, ESLint, formatting, unit/component tests and production builds. Corpus integrity tests check the fixed inputs for all modalities. `yarn test:integration` exercises real PostgreSQL RLS, pg-boss, S3, source revocation, concurrent base renames and tenant backup/restore on development dependencies. `yarn test:docker` performs a clean deployment with actual bundled media tools, PDF/OCR, image/speech/video, durable queue/API restart, SSE, Redis loss and recovery.

New Docker runs write `.artifacts/verification/docker.json`. This is generated, ignored output; inspect success and individual steps because a failed or incomplete record is not a release pass. [Earlier machine evidence](verification/saas-docker-2026-10-16.json) is historical. Infrastructure tests use TEST AI and make no paid provider requests. External model quality, provider billing and ARM64/M4 performance require their own checks; an Intel Docker pass does not establish them.

The [acceptance report of 16 October](verification/saas-2026-10-16.md) links the completed integration, Docker, full installation recovery, CLI and browser checks, and records the running development installation and remaining deployment prerequisites.

The subsequent [local AI report](verification/local-ai-2026-10-16.md) verifies real Docker Qwen3.5:4b, EmbeddingGemma and Whisper on text/photo/audio/video, server-side availability checks, Redis answer caching, offline reuse of weights and an answer after restarting Ollama. It supersedes the TEST-AI-only runtime status of the earlier acceptance report.

The [admin UX report](verification/admin-ux-2026-10-16.md) records the task-based navigation, owner/company role boundaries, server-side authorization, API-key configuration, separate settings forms and desktop/mobile browser checks.

The [credential vault report](verification/credential-vault-2026-10-16.md) supersedes the environment-only key configuration: encrypted owner-managed credentials, live API/worker rotation, role/CSRF checks and backup isolation are verified.

Obsolete SQLite-era temporary results and abandoned Docker attempts were removed. Curated SaaS reports and their linked evidence remain historical and are not rewritten as new passes. The [maintenance report](MAINTENANCE.md) records the present refactor, cleanup and verification scope; [admin UX](ADMIN-UX.md) explicitly separates the prototype from future React acceptance. See [requirements](REQUIREMENTS.md) and [operations](OPERATIONS.md).
