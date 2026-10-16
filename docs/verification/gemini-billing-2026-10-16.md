# Gemini multimodal billing — 2026-10-16

> Исторический отчёт: описывает проверенный на тот момент код. Актуальные инструкции — в [документации](../README.md); новый прототип — в [спецификации админки](../ADMIN-UX.md).

Implemented one current profile contract: `inputMicrosPerMillion` contains text/image/audio/video rates. No scalar-rate compatibility or old-data migrations. The PostgreSQL ledger stores the price snapshot, modality tokens and allocated cost, unattributed tokens, output cost and estimated flag. Rounding happens once per call and allocated lines reconcile exactly. PDF may contain text/image tokens; video may contain audio.

Before external I/O, a transaction reserves the full context at the highest possible input rate plus the configured output allowance. Final provider counters replace the reservation. Missing metadata uses a marked conservative estimate; network failures retain an uncertain reservation; explicit provider rejection releases it. Redis embedding cache hits create no extra ledger record. Generation also uses the effective current profile limits for the actual upstream call.

Owner admin has four USD-per-million input fields. Usage shows modality costs and small amounts to six decimals. CLI supports `models pricing ID --text 0.20 --image 0.45 --audio 6.50 --video 12 --output 0` through the same owner-only API. Current reference: [Google prices](https://ai.google.dev/gemini-api/docs/pricing#gemini-embedding-2), [embedding usage metadata](https://ai.google.dev/api/embeddings#EmbeddingUsageMetadata).

The document edit dialog no longer offers Published before an active indexed version exists. Drafts have a direct “Проверить и опубликовать” action. The backend still requires review/indexing and returns a clear Russian explanation for VERSION_NOT_READY. Verified both entry points in the browser on a synthetic draft.

## Verification

- `yarn validate`: passed (types, lint, format, docs/contracts, unit tests and builds).
- Final `yarn test:integration`: passed. Covers four-rate accounting, unavailable budget before provider I/O, concurrent reservations admitting only one affordable call, cache hits, rejected-provider reservation release, estimated fallback, tenant isolation, publication review, and backup/restore without rewinding charges. An initial run timed out waiting for a backup task; two subsequent runs passed.
- Docker images rebuilt and API, four worker services, PostgreSQL, Redis, S3, Ollama reported healthy.
- CLI pricing/save/status/usage and browser profile save passed. A concurrent CLI/UI edit correctly returned REVISION_CONFLICT; reloading the current profile saved successfully.
- Real Google calls used the existing encrypted platform credential in a separate company, “Проверка Gemini · тарифы”, with a $0.25 test budget. Synthetic policy, test PNG, repository JFK audio fixture and a two-second generated video were processed, reviewed and published. Flash answered “Отпуск необходимо запрашивать за 14 календарных дней [1].”
- Google returned actual counts for all four input modalities. Embedding cost: 3516 micro-USD; generation: 864 micro-USD; total: 4380 micro-USD ($0.00438). No remaining or uncertain reservations. Repeating the search added no cost. A separate budget-denial check left the amount unchanged.
- Raw results: [live scenario](gemini-billing-live-2026-10-16.json), [CLI profile](gemini-billing-cli-2026-10-16.json), [budget denial](gemini-billing-budget-2026-10-16.json). Screenshots: [usage](gemini-billing-usage-2026-10-16.png), [rates](gemini-billing-rates-2026-10-16.png), [review flow](gemini-publication-review-2026-10-16.png).

## Development data status

The incompatible development database was recreated under AGENTS.md. A full pre-change PostgreSQL dump, the unchanged encrypted credential vault and the two original uploaded files were saved in the private directory `/tmp/local-rag-billing-preserve` (directory 0700; source/config/database files 0600). The vault was restored and its Google credential verified. No plaintext Google key was written to files or reports.

Automatic approval review rejected replaying the original companies/settings/documents through the API, regarding this as an unauthorized bulk restoration despite the development reset rule. That replay was not executed or retried indirectly. At that point Demo A and Demo B contained fresh defaults. The user then explicitly authorized restoring Demo A, publication and verification; this is now complete, as documented in [the restoration report](demo-a-restored-2026-10-16.md). Demo B was left unchanged. The separate verification company contains synthetic test data and functioning Google model profiles. No compatibility mechanism was added to the product.
