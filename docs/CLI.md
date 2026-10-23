# CLI

Run `yarn cli help`. CLI uses the same HTTP API, permissions and tenant checks as the browser. The local init/bootstrap/serve/worker/seed/prepare-local/check commands operate on deployment configuration directly. There is no legacy offline database adapter.

```sh
yarn cli init
# Password via stdin, not a shell argument or history:
read -s OPERATOR_PASSWORD
printf '%s' "$OPERATOR_PASSWORD" | yarn cli bootstrap admin --name 'My Company'
unset OPERATOR_PASSWORD

yarn cli login admin
yarn cli tenants list
yarn cli tenant-use TENANT_UUID
yarn cli collections save input.json
yarn cli upload ./manual.pdf COLLECTION_UUID
yarn cli watch JOB_UUID
yarn cli review DOCUMENT_UUID
yarn cli publish DOCUMENT_UUID
yarn cli ask 'How often should XZ-417 be serviced?'
yarn cli ask 'What is shown here?' --file ./photo.jpg
yarn cli search 'XZ-417'
yarn cli download DOCUMENT_UUID ./original.pdf
yarn cli export CONVERSATION_UUID ./conversation.json
```

`login` reads the password from stdin. Credentials are mode 0600 under `~/.local/share/local-rag/cli.json`; use RAG_CLI_FILE to choose a private location. `--url`, `--tenant`, `--json` apply to API commands. Upload progress persists on the server; retry interrupted binary upload with `--upload UPLOAD_UUID`. SHA-256 and length must still match. `ask --file` explicitly processes and publishes the private attachment before asking.

From the project root, `yarn demo:import` reuses the saved CLI session/company and uploads the [checked-in multimodal corpus](../examples/knowledge-base/README.md) into a new knowledge base. It waits for extraction but leaves publication for review. `--publish` acknowledges/indexes demo data explicitly; failures return code 1 with the saved base/job context. Every invocation creates a new base. It uses no separate database/authorization bypass. `seed` creates the development identity/companies only and is prohibited in production.

Administrative actions accept JSON files or stdin: `yarn cli models list`, `yarn cli models save profile.json`, `yarn cli indexes build input.json`, `yarn cli indexes activate input.json`, `yarn cli settings save input.json`, `yarn cli backup create`, `yarn cli backup verify input.json`, `yarn cli backup restore input.json`, `yarn cli usage read`, `yarn cli cache clear`, `yarn cli audit list`, `yarn cli invitations create input.json`. All actions are also available through `yarn cli api ACTION input.json`; input fields are in [API](API.md). The invitation token is shown once; the employee accepts it in the UI or with `yarn cli accept-invite TOKEN` and password on stdin.

`yarn cli sync CONNECTOR_UUID ./directory [--watch]` hashes a local manifest and uploads changes through resumable sessions. The server stores connector metadata, never reads a client filesystem path. Removed-file policy is keep/exclude/delete. New or replaced documents require review/publication. Symbolic links are skipped.

`watch JOB_UUID` reconnects to saved SSE state; waiting does not create another AI call. `cancel` fences the active attempt. `retry` records a new job and requires explicit review for uncertain provider outcomes. `diagnose` and local `check` inspect the configured installation. Whole-installation snapshot commands are in [operations](OPERATIONS.md).

`users.revoke` ends all global sessions for an account and is operator-only. A company administrator can block membership with `users.update`; access to other companies remains unchanged.

## Model checks and prices

The platform owner sets separate input/output rates in USD per million tokens:

```sh
yarn cli models pricing PROFILE_UUID --text 0.20 --image 0.45 --audio 6.50 --video 12 --output 0
yarn cli usage read --json
```

All five rates are required. Example numbers illustrate the format, not current vendor prices. Verify the account tariff before enabling a paid profile. In profile JSON, `inputMicrosPerMillion` is `{ "text": 200000, "image": 450000, "audio": 6500000, "video": 12000000 }`; scalar rates are rejected. `usage read` reports tokens/costs by modality, unallocated tokens, and estimated calls. Authorization and budget checks are shared with the UI.

After login use `yarn cli models status` or `yarn cli models status <profile-id> --json`. Each result includes enabled, ok and a readable message. Exit code 1 means at least one enabled checked profile is unavailable. Disabled optional cloud profiles can report missing credentials without failing the status command. The same checks run in the admin UI; they inspect connectivity and installed models without requesting a generated answer.

Deployment diagnostics (`diagnostics`), connection changes (`models.save/delete`), and company lifecycle (`tenants.create/update`) require platform owner permission. CLI and browser use the same server checks.

## Provider API keys

`yarn cli secrets list` returns metadata only. `yarn cli secrets save` accepts JSON on stdin: id, label, provider, enabled, revision, and value. Creation requires revision=0 and a value; updates require the current revision and may omit value to keep it. Never put keys in command arguments or URLs. For automation, pipe JSON from a secret manager rather than saving values in shell history or project files.

`yarn cli secrets delete` accepts id/revision on stdin and requires no profile references in any company. `yarn cli secrets audit` returns a value-free log. All commands require operator permission and affect new calls without restart. See the [API contract](API.md).

## Correcting processing before publication

After `yarn cli review DOCUMENT_UUID`, call `yarn cli api documents.correct correction.json`. Supply id, current document revision, version, page, and corrected text. Reread and acknowledge publication with `publish`. Originals remain unchanged; published versions cannot be edited in place.

Google transcription uses `models save`: provider=google, role=transcription, input=[text,audio], secretRef for an enabled Google key, an audio-capable Gemini model, and current prices. Then `settings save` assigns its id to transcriptionProfile using the current settings revision. The same budget/access checks apply; an unavailable Whisper profile does not trigger automatic cloud failover.

`indexes build` automatically prepares missing descriptions/transcripts with selected company processing profiles. Existing text is reused for another embedding model. Check the text through `review` and inspect retrieval before `indexes activate`; preparation failure leaves the current index active.

## Text windows and document find

`yarn cli review DOCUMENT_UUID --page 2 --offset 12000` returns metadata and one bounded window, not all text of every version. Use nextOffset for the next window. `yarn cli api documents.page input.json` allows an explicit limit, and `yarn cli api documents.find input.json` returns literal matches with snippets and positions. These operations use the same read/edit/version checks as the browser. For a window correction pass range={start,end} in documents.correct; omitting range deliberately replaces the whole page.

`yarn cli revise DOCUMENT_UUID [--version VERSION_UUID]` creates a separate correction version from published material and waits for asset copying. Then use `review`, `documents.correct`, and `publish`. Originals and derivatives are copied server-side without repeated recognition. Readers retain the current publication until the candidate succeeds.
