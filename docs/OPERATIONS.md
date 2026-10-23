# Deployment and recovery

## Production Docker installation

Install Docker Engine/Compose v2, or Docker Desktop on macOS. Keep PostgreSQL, Redis, S3, and the Docker socket private. Install Node.js for repository configuration commands.

```sh
yarn install --immutable
yarn configure --production
# Edit .env: TLS_DOMAIN, DOCKER_PUBLIC_ORIGIN, RAG_PUBLIC_ORIGIN.
docker compose --env-file .env -p local-rag-saas-app -f compose.yaml -f compose.production.yaml --profile app up -d --build --wait
```

Point a real domain at the server and expose ports 80/443. Caddy obtains TLS certificates; nginx serves assets and proxies API/SSE without buffering. The production overlay removes the client's public HTTP mapping. Do not run development seed or use example credentials in production.

Create the first operator through stdin:

```sh
read -s OPERATOR_PASSWORD
printf '%s' "$OPERATOR_PASSWORD" | docker compose --env-file .env -p local-rag-saas-app --profile app exec -T api node server/dist/interfaces/cli/main.js bootstrap admin --name 'My Company'
unset OPERATOR_PASSWORD
```

Add provider keys through platform administration, then configure profiles with actual models, current tariffs, and limits. Rotation/disable affects new calls without restart. Keys are encrypted in PostgreSQL; protect `APP_ENCRYPTION_KEY` separately. A full database dump includes encrypted credentials; company backups exclude them. Do not enter a secret as a model name or endpoint.

Ollama endpoints must be allowed by `AI_ALLOWED_ENDPOINTS`. Container localhost refers to that container, not the host. Use a reachable dedicated model server, `host.docker.internal` where supported, or the optional Compose model service.

Server containers use read-only roots, temporary `/tmp`, and the unprivileged `node` user. PostgreSQL/S3 have persistent volumes; Redis is disposable. Company limits do not change container CPU/memory caps. Account for a connection pool per API/worker process when scaling queues.

Required PDF/OCR resources are copied from `server/resources/extraction`. Sample documents and `.artifacts/` are excluded from image build context. Import [sample data](../examples/knowledge-base/README.md) from a checkout through the public API if needed.

## Health and updates

`/health/live` checks the process. `/health/ready` checks PostgreSQL and cache state. Owner diagnostics separately inspect S3, workers, FFmpeg, Whisper, PDF, and OCR. A live HTTP endpoint does not establish model or search readiness. OpenTelemetry is optional through `OTEL_EXPORTER_OTLP_ENDPOINT`; enhanced SQL parameter/document text capture is disabled.

For a material failure inspect the job/diagnostic ID, worker, processing runtime, assigned model, and budget. For an answer failure also check the active index, publication, grants, and generation profile. See [usage](USAGE.md).

Before an incompatible update preserve a backup, stop the application, and prepare a compatible installation. Current schema version 7 rejects old schemas/backups without migration. Recreate only disposable development resources. Deploy client, API, and workers from the same revision.

## Company backup

Use `backup.create`, wait, run `backup.verify`, then `backup.restore` and wait for its maintenance job. The S3 backup contains a consistent PostgreSQL snapshot and independent immutable object copies. HMAC with `APP_ENCRYPTION_KEY` and SHA-256 protect format and integrity.

Restoration blocks the target company and fences its jobs. It does not replace global passwords or another company's data. Current usage, owner entitlements, prices, and model catalog are retained. If an old embedding profile is unavailable, select a current profile and rebuild. Restoring a backup cannot undo provider expenses.

The maintenance worker schedules backups/cleanup. `backupIntervalHours=0` disables scheduled backups; `backupDays` controls retention. Expired uploads, history/jobs/audits, and pending object deletions are cleaned according to settings. Keep disaster recovery copies on separate protected storage.

## Whole-installation snapshot

Operator-only, for local S3 in Compose. The tool pauses API/workers/storage while PostgreSQL remains available for `pg_dump`; no host PostgreSQL installation is required.

```sh
# INSTALLATION_PROJECT defaults to local-rag-saas-app.
yarn installation:backup /secure/new-snapshot-directory
# Back up the private .env separately.
yarn installation:restore /secure/new-snapshot-directory --confirm-replace-installation
```

Snapshots contain `postgres.dump`, `storage.tar`, and a checksummed `manifest.json`. Directories use mode 0700 and files 0600. Restore replaces the selected initialized installation and requires its matching private `.env`. Accept only trusted current-format operator snapshots. External S3 needs a provider-specific consistent snapshot/versioning strategy; the filesystem snapshot tool does not cover it.

A crash after sending an AI request can leave billing uncertain. Check the provider before manual retry. Redis outage needs no business-data restore. Recover PostgreSQL/S3 rather than creating duplicate company identities after an outage.

## Local model deployment and transfer

A local installation adds `compose.local-ai.yaml`; public HTTPS also adds `compose.production.yaml`:

```sh
docker compose --env-file .env -f compose.yaml -f compose.local-ai.yaml -f compose.production.yaml --profile app up -d --build --wait --wait-timeout 3600
```

`yarn docker:up` selects the local overlay when `LOCAL_AI=1`. GPU acceleration on Linux requires a suitable NVIDIA/ROCm runtime and override. The portable default is CPU. Docker on macOS does not automatically provide Metal; a reachable native Ollama endpoint can use host acceleration.

Preserve private `.env`, data snapshots, and deployment files. Ollama/Whisper software comes from versioned images. Qwen/EmbeddingGemma weights live in `ollama-data`; database/S3 snapshots exclude that volume. For an offline move, stop Ollama and export/import the model volume separately, or allow the new initializer to download weights. Existing volumes reuse installed weights. Record model digests for reproducibility and rebuild embedding indexes if downloaded model weights change.

Moving the source folder alone does not move customer data, secrets, or volumes. The destination needs Docker/Compose, sufficient RAM/disk, and Internet for first downloads; no manual host installation of Ollama/FFmpeg/Whisper is needed for the container route.

## Strict formats and media runtime

Tenant snapshots use the current writable-column format; generated metadata columns recalculate on restore. Old signatures fail without conversion. A failed check never authorizes erasing an existing installation: recreate only disposable test/development resources or keep the matching old installation separately.

Native `yarn prepare:media` replaces only a directory with its managed ownership receipt. It builds current H.264-enabled FFmpeg and pinned Whisper, verifies downloads, and reuses valid weights. Docker installs the same tools during image build. Diagnostics rejects obsolete receipts or missing codecs. Explicit `FFMPEG_BIN`, `FFPROBE_BIN`, and `WHISPER_BIN` overrides remain deployment choices and must satisfy the same requirements.
