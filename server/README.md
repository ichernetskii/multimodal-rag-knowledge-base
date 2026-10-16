# Node.js server

API, workers and CLI share the application services and public contract. PostgreSQL stores business data and pg-boss jobs; S3 stores immutable originals and derived media; Redis is disposable. Runtime PostgreSQL role cannot bypass RLS. Database initialization is an operator command with a separate admin connection.

See [architecture](../docs/ARCHITECTURE.md), [API](../docs/API.md), [CLI](../docs/CLI.md), [development](../docs/DEVELOPMENT.md) and [operations](../docs/OPERATIONS.md).

No SQLite/HuggingFace embedding runtime or old API adapters remain. Do not point version 7 at a legacy database.

`src/application/application.ts` validates and dispatches the public actions. `features/knowledge-bases/knowledge-base-service.ts` owns grants, summaries and transactional mutations; `features/operations/retention-service.ts` owns retention and garbage collection. The shared application services enforce the same rules for HTTP and CLI.

PDF extraction/rendering and Apple Vision sources live in `resources/extraction/`; these are production resources, copied into the server image. Development/build/PDF preparation commands live in root `tooling/server/`. Run them through workspace/root package scripts so paths do not depend on the caller's directory. The compiled server resolves resources relative to its server root.

Reusable multimodal data lives in [examples/knowledge-base](../examples/knowledge-base/README.md). Tests consume the same checked-in inputs. Local `.cache` holds managed runtimes/weights and `.venv` holds Python dependencies; neither is sample data. No local SQLite data directory is used by this architecture.
