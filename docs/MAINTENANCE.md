# Maintenance and code organization

The admin uses the public API. Client code never imports server services. There is one current contract and database format, with no compatibility adapters. See [verification](VERIFICATION.md) for reproducible checks.

## Main boundaries

| Area                                  | Responsibility                                                             |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `client/src/app`                      | Composition, stores, scoped navigation, unsaved-form registry              |
| `client/src/features`                 | Knowledge workspace, reader/find, model editor, company/platform workflows |
| `server/src/application`              | Public action validation and dispatch                                      |
| `server/src/features/knowledge-bases` | Grants, batched counts, transactional base mutations                       |
| `server/src/features/documents`       | Metadata catalog, bounded reader, safe review/correction versions          |
| `server/src/features/operations`      | Retention, garbage collection, operational workflows                       |
| `server/resources/extraction`         | Required Python/Swift runtime helpers                                      |
| `tooling`                             | Development, build, configuration, and isolated verification commands      |
| `examples/knowledge-base`             | Fixed multimodal inputs and checksummed manifest                           |

Document lists fetch metadata with bounded query counts instead of loading every version/transcript. Reading and comparing use text windows. UTF-16 range corrections preserve untouched content. Personal attachments supply relevant indexed fragments rather than entire long pages.

Correction versions copy originals and derivatives independently. Storage, revision, current access, and job-attempt fences protect writes. Current publication/index remains active until the candidate succeeds. OCR/ASR/description generation is not repeated just to correct text. Video previews use a poster inside the player instead of displaying the same frame twice.

Provider credentials belong to the encrypted platform vault. Tenant backups cannot rewind keys, prices, usage, or owner entitlements. Company settings and deployment resource limits are separate.

## Publication hygiene

Public documentation and the application interface use English. Each README has a Russian `README.ru.md` counterpart, including the [main introduction](../README.ru.md). Existing package scopes, CLI storage paths, and Compose project identifiers remain stable technical identifiers; the product/repository name is Multimodal RAG Knowledge Base.

Private `.env` files, credentials, runtime caches, weights, databases, uploads, snapshots, generated logs, and historical internal reports stay outside tracked source. `.gitignore` and `.dockerignore` enforce these boundaries. Curated real-app screenshots use disposable sample data.

The old `server/scripts`, duplicate sample directories, replaced navigation, and old API adapters are not needed. Managed runtimes, model weights, and Python environments are working local dependencies, not disposable source clutter. Removing tracked historical reports does not remove them from Git history; history is scanned separately for secrets.

## Changing the product

Keep authorization at every version/fragment/asset boundary. Keep HTTP responses bounded. Build and explicitly activate a candidate when changing embedding space. Preserve diagnostic reasons rather than reporting a failed dependency as ready. Check real provider behavior separately from deterministic TEST AI infrastructure scenarios.

Use isolated databases and buckets for integration/browser verification; never reset a working installation merely to run tests. Incompatible formats are rejected. Recreate only disposable development/test resources instead of adding migrations for unreleased schemas.
