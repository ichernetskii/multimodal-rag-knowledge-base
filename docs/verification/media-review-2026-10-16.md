# Media review and Google transcription · 16 October 2026

Implemented in source: Google Gemini transcription profiles using the existing Google credential vault, budget/rate/concurrency accounting and WAV segments; rejection of truncated provider transcripts; editable text before publication with revision/ACL/job checks; explicit review acknowledgment; client text search and readable paragraphs. Google Cloud Speech-to-Text with Cloud IAM is a separate service and is not implemented here.

The prototype separates company and platform contexts (no company picker in platform settings), keeps saved text when the search model changes, supports actual local text matching across all sample sections, and simulates corrections/Google ASR assignment. Demo controls are outside the product shell. Its iframe sandbox and both CSP policies were preserved.

Verification:

- Server unit suite: passes, including rejection of technical media labels as descriptions for text-only indexing and reservation of transcription output costs. Client suite: 27 tests pass.
- Typecheck, ESLint, documentation/action coverage, generated contracts, formatting of changed files and production client/server builds pass.
- Full SaaS integration passes in an isolated PostgreSQL database with real local Redis/S3. A local HTTP Google API fixture verifies exact WAV transport, transcript/usage accounting, MAX_TOKENS rejection and segment-duration limits. Correction tests verify tenant isolation, stale revisions, original hash preservation, acknowledgment reset, publication and rejection of edits to published versions. The temporary database is removed afterward.
- Prototype browser checks: real P-204 matches in sections 16/18, empty results, correction and acknowledgment reset, text retained after native-search activation, shared keys in a separate platform context, Google ASR selection, local/cloud fields, role restrictions, and 320 px without horizontal overflow. No browser console errors observed.

Limits: the Google test used a local protocol fixture, not a paid live call or an ASR accuracy benchmark. The new public contract changes the development database/backup format; the existing Demo A database was preserved and was not converted or reset. It must be recreated in the current format before running this server release, following AGENTS.md. The prototype's platform navigation is not yet the full React navigation implementation. documents.read still returns a whole version; server page pagination remains separate work.
