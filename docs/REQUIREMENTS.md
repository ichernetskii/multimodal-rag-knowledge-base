# Requirements and scope

1. A clean installation creates PostgreSQL tables, pg-boss queues, and a private S3 bucket. The first operator is created only by an administrative CLI command.
2. Company memberships, RLS, search, files, caches, jobs, chats, and backups are isolated. Personal data remains owner-only.
3. Resumable multipart uploads verify length/SHA-256 before extraction. Publication requires explicit review acknowledgement.
4. Retrieval combines vectors, full-text, and technical identifiers with immutable source provenance. Revocation applies to new search, historical answers, and assets.
5. Job admission and pg-boss delivery commit together. Idempotency, cancellation, attempt fencing, retry/backoff, worker recovery, and uncertain external outcomes are visible.
6. Generation, indexing, and processing have deployment limits. Company/profile concurrency, rates, and budgets add separate caps. Queue admission rejects excess work before acceptance.
7. Google, Anthropic, Ollama, compatible APIs, and Whisper expose actual implemented capabilities. A new embedding space requires a candidate build and atomic activation.
8. Redis loss cannot lose accepted jobs or bypass authorization. Revision keys invalidate caches; SSE reconnect does not repeat an AI call.
9. Browser and CLI use one public contract. Folder sync reads the CLI computer through resumable API uploads, never a server-side path into a client disk.
10. Current-format tenant backups verify HMAC/SHA and restore only the target company. Installation snapshots coordinate PostgreSQL and local S3 recovery.
11. Development includes pinned Yarn, Compose dependencies, hot reload, seed, guarded reset, isolated verification, and CI. Production uses private configuration, HTTPS, readiness, and graceful shutdown.
12. Incompatible data and backup formats fail clearly without migration. Generated evidence remains in ignored `.artifacts/`.
13. Fixed samples cover all five modalities with hashes and expected facts. Heavy decoders run in Docker acceptance; real AI quality is evaluated separately from TEST AI.
14. Concurrent writes check revisions rather than silently overwrite. Base lists enforce ACL and batch material counts.
15. The [admin workspace](ADMIN-UX.md) separates company and platform scopes. Models are assigned by task; connections reference a separate key vault. Material review includes correction, bounded reading, literal find, and explicit publication.
16. The published application interface and primary documentation are English. Real-app screenshots contain only disposable sample data, and local secrets remain untracked.

The current product is a self-hosted application foundation, not a complete commercial billing platform. Payments, SSO/SAML, enterprise DLP/antivirus, live price discovery, microphone question dictation, generated image output, and managed cloud autoscaling are outside the current contract. Deterministic infrastructure tests do not establish model quality.
