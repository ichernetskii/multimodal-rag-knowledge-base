# HTTP API v7

Public types and validation field lists live in [public.ts](../server/src/contracts/public.ts). Client contracts are generated; unsupported action names and extra fields fail. This API has no compatibility endpoints for earlier releases.

POST /api/login accepts login/password and optional cli=true; browser receives HttpOnly/SameSite cookie, CLI receives bearer token. X-Tenant-ID selects a verified membership; GET/SSE/media use an equivalent tenant query parameter. Mutating cookie requests require the configured same origin. POST /api/logout revokes the session. POST /api/invitations/accept accepts token/password and grants the invitation membership after account authentication.

POST /api/actions/ACTION takes a JSON object (max 1 MiB), returns the typed result. answers.create returns 202 after durable acceptance; other actions return their result or job descriptor. Errors have error.code, error.message and error.diagnostic; transport status distinguishes 401/403/404/409/413/429/503. Exact authority and revision rules are enforced server-side; tenant admin does not bypass personal conversation ownership.

Platform-only actions include secrets.list/save/delete/audit, diagnostics, tenants.create/update, models.save/delete and users.revoke. Company administrators manage their own team, settings, usage, indexes and jobs. models.list exposes no endpoint or secret reference to non-operators; it includes enabled profiles and, for company administrators, selected disabled profiles. Provider credentials never appear in API results.

`collections.list` returns only accessible knowledge bases, visible grants and a `documentCount` scoped to each base. Counts are fetched together under tenant RLS. `collections.save/delete` require company admin; rename requires edit access. All three mutations serialize through the shared access lock and check the current revision, so concurrent edits cannot silently overwrite one another. No API format changed in this refactor.

| Action                   | Allowed input fields                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `answers.create`         | `conversation`, `revision`, `question`, `replaces`, `scope`, `attachments`, `idempotencyKey`, `profile` |
| `backup.create`          | none                                                                                                    |
| `backup.list`            | none                                                                                                    |
| `backup.restore`         | `id`                                                                                                    |
| `backup.verify`          | `id`                                                                                                    |
| `cleanup`                | none                                                                                                    |
| `collections.list`       | none                                                                                                    |
| `collections.rename`     | `id`, `revision`, `name`                                                                                |
| `collections.save`       | `id`, `revision`, `name`, `grants`                                                                      |
| `conversations.create`   | `title`                                                                                                 |
| `conversations.delete`   | `id`, `revision`                                                                                        |
| `conversations.list`     | `query`, `page`, `pageSize`                                                                             |
| `conversations.read`     | `id`, `before`, `pageSize`                                                                              |
| `conversations.variants` | `id`, `parent`, `page`, `pageSize`                                                                      |
| `conversations.save`     | `id`, `revision`, `title`, `draft`, `selected`                                                          |
| `diagnostics`            | none                                                                                                    |
| `documents.bulk`         | `ids`, `revisions`, `operation`                                                                         |
| `documents.compare`      | `id`, `left`, `right`                                                                                   |
| `documents.correct`      | `id`, `revision`, `version`, `page`, `text`                                                             |
| `documents.delete`       | `id`, `revision`                                                                                        |
| `documents.limits`       | none                                                                                                    |
| `documents.list`         | `query`, `sort`, `state`, `scope`, `page`, `pageSize`                                                   |
| `documents.preview`      | `collection`, `conversation`, `files`                                                                   |
| `documents.publish`      | `id`, `revision`, `version`, `acknowledge`, `activate`                                                  |
| `documents.read`         | `id`, `version`                                                                                         |
| `documents.restore`      | `id`, `revision`, `version`                                                                             |
| `documents.update`       | `id`, `revision`, `name`, `state`                                                                       |
| `documents.upload`       | `upload`                                                                                                |
| `uploads.create`         | `collection`, `conversation`, `name`, `bytes`, `sha256`, `document`, `revision`                         |
| `uploads.read`           | `id`                                                                                                    |
| `feedback.create`        | `turn`, `rating`, `reason`, `detail`                                                                    |
| `groups.list`            | none                                                                                                    |
| `groups.save`            | `id`, `revision`, `name`                                                                                |
| `jobs.cancel`            | `id`                                                                                                    |
| `jobs.retry`             | `id`                                                                                                    |
| `jobs.list`              | `page`, `pageSize`                                                                                      |
| `invitations.list`       | none                                                                                                    |
| `invitations.create`     | `login`, `role`                                                                                         |
| `invitations.revoke`     | `id`                                                                                                    |
| `collections.delete`     | `id`, `revision`                                                                                        |
| `tenants.list`           | none                                                                                                    |
| `tenants.create`         | `name`                                                                                                  |
| `tenants.update`         | `id`, `revision`, `name`, `blocked`                                                                     |
| `secrets.list`           | none                                                                                                    |
| `secrets.save`           | `id`, `label`, `provider`, `enabled`, `revision`, `value`                                               |
| `secrets.delete`         | `id`, `revision`                                                                                        |
| `secrets.audit`          | `page`, `pageSize`                                                                                      |
| `models.list`            | none                                                                                                    |
| `models.save`            | `profile`                                                                                               |
| `models.delete`          | `id`, `revision`                                                                                        |
| `models.check`           | `id`                                                                                                    |
| `indexes.list`           | none                                                                                                    |
| `indexes.build`          | `profile`                                                                                               |
| `indexes.activate`       | `id`                                                                                                    |
| `usage.read`             | none                                                                                                    |
| `cache.clear`            | none                                                                                                    |
| `audit.list`             | `page`, `pageSize`                                                                                      |
| `jobs.read`              | `id`                                                                                                    |
| `me`                     | none                                                                                                    |
| `operations`             | none                                                                                                    |
| `password.change`        | `oldPassword`, `password`                                                                               |
| `quality.results`        | `job`, `page`, `pageSize`                                                                               |
| `quality.list`           | `page`, `pageSize`                                                                                      |
| `quality.delete`         | `id`, `revision`                                                                                        |
| `quality.run`            | none                                                                                                    |
| `quality.save`           | `id`, `revision`, `question`, `scope`, `documents`, `facts`, `refuse`                                   |
| `search`                 | `question`, `scope`                                                                                     |
| `sources.read`           | `chunk`                                                                                                 |
| `sessions.list`          | none                                                                                                    |
| `sessions.revoke`        | `id`                                                                                                    |
| `settings.read`          | none                                                                                                    |
| `settings.save`          | `revision`, `settings`                                                                                  |
| `setup.status`           | none                                                                                                    |
| `sync.delete`            | `id`, `revision`                                                                                        |
| `sync.list`              | none                                                                                                    |
| `sync.preview`           | `id`, `files`                                                                                           |
| `sync.report`            | `id`, `revision`, `mapping`                                                                             |
| `sync.save`              | `id`, `revision`, `collection`, `path`, `policy`, `intervalMinutes`                                     |
| `users.create`           | `login`, `password`, `role`, `groups`, `blocked`                                                        |
| `users.list`             | `query`, `role`, `state`, `ids`, `page`, `pageSize`                                                     |
| `users.revoke`           | `id`                                                                                                    |
| `users.update`           | `id`, `revision`, `role`, `blocked`, `password`, `groups`                                               |

## Upload, streaming and downloads

uploads.create reserves a session after ACL/quota validation. PUT /api/uploads/UUID streams a binary part (up to 8 MiB), with Upload-Offset and SHA-256 declared in the session. uploads.read returns the accepted offset. documents.upload finalizes only after full object checksum/length verification and returns the document, version and durable extraction job. Review and documents.publish make a version searchable.

`documents.correct` changes one page or segment's text/sections in an unpublished version in `review`. It requires edit access and the current document revision. The original and media assets are preserved; acknowledgment resets, the document revision increments, and an audit entry is recorded. Versions with unfinished processing/publication jobs and pending/ready/published versions cannot be edited. Stale corrections return `REVISION_CONFLICT`. For a published source, upload and review a new version.

GET /api/events/JOB emits event: snapshot, id: job.updated and data containing job plus an authorized turn. Last-Event-ID resumes from saved snapshots. A client receives the final snapshot even if it connected after completion. Heartbeats keep the connection alive. The transport bounds stream lifetime, per-user connections and buffering; PostgreSQL, not the live socket, stores progress.

GET /api/documents/UUID?version=VERSION downloads the original; /api/documents/UUID/media/ASSET retrieves a derived source. Both require current ACL and support byte ranges. Files are private; there is no public S3 URL. GET /api/conversations/UUID/export emits the owner's history with source redaction and bounded writes. /health/live and /health/ready are unauthenticated operational probes.

Only setup.status is a public action. init/bootstrap are exclusive operator CLI commands. models.save cannot change indexed embedding identity; indexes.build creates a separate space, indexes.activate requires a complete build for the unchanged corpus. cache.clear invalidates current tenant revisions. backup.restore returns a maintenance job and blocks that tenant until completion.

## Platform API credentials

`secrets.save` creates a credential with revision 0 and a required `value`; updates require the current revision. Omit `value` to keep it. Empty values are rejected. IDs are stable lowercase aliases (up to 64 characters); provider is immutable. Provider values are google, anthropic, openai-compatible. Responses contain only id, label, provider, enabled, revision, timestamps and a cross-company profile reference count (`uses`). Neither plaintext nor ciphertext, nonce, tag or value suffixes are returned, including to operators. Disabled credentials block new provider calls. Already dispatched calls may finish; cached answers do not require a provider call.

Delete requires the current revision and zero references across all companies, including disabled model profiles. Saving a model reference and deleting a credential share a transaction lock. Recreating an alias receives a new global revision, preventing a stale editor from overwriting its replacement. `secrets.audit` is owner-only and never contains key values. Tenant backups exclude the credential vault and its audit; tenant restore cannot roll back credentials. Every request uses the existing same-origin/CSRF and authentication checks.
