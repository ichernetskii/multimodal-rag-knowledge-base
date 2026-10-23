# Verification

Run checks against the current checkout; old reports are not a substitute for a fresh pass.

| Command                 | Coverage                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `yarn validate`         | Documentation links/action fields/scripts/environment reference, generated contracts, TypeScript, ESLint, formatting, server/client tests, production builds |
| `yarn test:integration` | Isolated PostgreSQL/RLS, pg-boss, S3, access revocation, concurrent updates, reader/corrections, provider key vault, company backup/restore                  |
| `yarn test:docker`      | Fresh deployment, bundled PDF/OCR/media/Whisper, all sample modalities, API/worker restart, SSE, Redis loss/recovery                                         |
| `yarn test:workspace`   | Disposable browser workspace with real API/workers, sample corpus, long text, broken PDF, and all roles                                                      |

Integration/workspace checks require `yarn infra:up`. The browser workspace additionally needs `yarn build:client`, `yarn prepare:pdf`, and `yarn prepare:media` for native processing. It prints its random loopback URL and disposable credentials. Ctrl+C closes its servers and removes only its owned database/bucket. It never resets existing development or Docker application data.

TEST AI is deterministic and explicitly labelled. It checks infrastructure and workflows without paid model calls. PDF/OCR, Whisper, and video decoding are real. Evaluate actual answer/embedding quality separately with configured providers and [corpus questions](../examples/knowledge-base/manifest.json). Intel results do not establish ARM64 or GPU performance. Connection health does not establish answer quality or current provider pricing.

Generated results belong in ignored `.artifacts/verification/` or `.artifacts/publication/`. Inspect exit status and every stage; incomplete output is not a pass. Historical internal reports are retained locally and excluded from publication. README screenshots are real browser captures from disposable sample data, not mockups.

## Secret checks before publishing

Scan the complete Git history and current tracked source with Gitleaks. `.gitleaksignore` records one exact historical prose false positive. `.gitleaks.toml` extends all default rules and permits only an exact environment-variable reference and tokenizer signature in their source files; no general source paths or real credentials are suppressed. Also compare private local credential values against Git objects without printing the values. Keep `.env`, CLI credentials, databases, provider keys, snapshots, and runtime caches untracked. Review screenshots for private information.

CI runs validation, full-history secret scanning, and Docker acceptance. Local-only configuration is deliberately absent from Git; use `yarn configure` on a clean checkout. See [security guidance](../SECURITY.md).

## Regression coverage from the project review

| Failure checked                                                                              | Required behavior                                                 |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| JSON `null`, primitives, arrays, and malformed syntax on HTTP routes                         | Bounded `400` errors before calling identity/application services |
| Malformed percent-encoded session cookie                                                     | `401 UNAUTHENTICATED`, without a technical server error           |
| Provider HTTP 307 on health, generation, or embeddings                                       | Reject without forwarding credentials or document input           |
| Google, Anthropic, compatible API, or Ollama closes an unfinished stream / hits output limit | Fail explicitly; never mark or cache it as a complete answer      |
| Failure writing the company-creation audit                                                   | Roll back company, membership, and initial profiles together      |
| Invalid search/material-list scope                                                           | Reject before retrieval or provider work                          |
| Missing English/Russian README companion                                                     | Fail documentation validation                                     |

Stream fixtures follow the published [Gemini finish reasons](https://ai.google.dev/api/generate-content#FinishReason), [Anthropic event sequence](https://platform.claude.com/docs/en/build-with-claude/streaming), [Chat Completions finish reasons](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events), and [Ollama completion fields](https://docs.ollama.com/api/chat). Provider tests include fragmented transport records, explicit successful completion, premature closure, and output-limit stops. Redirect checks use two real loopback HTTP servers and synthetic credentials.

These checks cover protocol and workflow correctness. Paid provider accounts, semantic answer quality, public HTTPS/DNS, multi-host load, and ARM/GPU performance require installation-specific acceptance. The repository does not yet specify a project license; third-party runtime/sample licenses remain included.
