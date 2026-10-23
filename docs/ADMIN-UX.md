# Admin workspace

This describes the implemented React interface, not a disconnected prototype. [Usage](USAGE.md) explains everyday tasks; [verification](VERIFICATION.md) explains how to check them.

## Navigation and scope

A persistent sidebar groups company work separately from platform administration. The company selector appears only on company pages. Platform pages display **All companies**. The footer identifies the account and real role; changing scope does not rewrite navigation into a different application.

| Authority             | Available work                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| User                  | Chat, published permitted materials, own personal attachments                                                          |
| Editor                | Upload, review, correct, publish, and sync folders for bases with edit access                                          |
| Company administrator | Bases and grants, team, model assignments, quality, costs, jobs, backups, company settings                             |
| Platform owner        | Independent authority: provider keys, model connections, system diagnostics, company lifecycle, increased entitlements |

Editor role alone does not grant access to every base. Operator permission does not replace company membership. Private chats and attachments remain private even from company administrators. Server authorization checks every material, version, fragment, and asset.

## AI and models

**Model assignments** groups answers, recording transcription, and the search index. Answer/ASR selection changes company settings. Search uses a build → review → activate workflow; a failed candidate leaves the current index active. Availability checks and index readiness are separate.

Saved material text survives embedding model changes. Building a text index prepares missing image descriptions through an image-capable answer model and speech through selected Whisper/Google ASR. Profile/model/time provenance is retained; existing text is reused.

**Connected models** is owner-only within the company scope. Profiles are grouped by **On your server**, **External API**, and **Development & verification**. The last group contains TEST AI rather than an external provider. The provider/task determine available fields. Existing provider/task identities are fixed; copying creates a new profile.

| Provider                            | Main parameters                                   | Advanced parameters                                                       |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| Ollama                              | Name, task, server URL, installed model, enabled  | Context, timeout, concurrency, supported inputs                           |
| Whisper                             | Name, bundled small model, enabled                | Company processing controls language/CPU; no endpoint                     |
| Google / Anthropic / compatible API | Name, task, model, endpoint, shared key reference | Modalities, context, size/duration, RPM/TPM, timeout, concurrency, prices |

A compatible API can be self-hosted. Prices support reservation and estimated accounting; they do not install a model. The owner verifies actual provider tariffs. Connection checks are not answer-quality benchmarks.

Shared keys have a separate platform page. Profiles reference aliases, never values. Values are submitted only on creation/rotation and cannot be retrieved after saving. Connection pages expose key state and a route to the vault without giving company administrators secret access.

## Knowledge workspace

Permission-aware tabs group materials, bases/access, folders, and answer quality. Filename filtering, content retrieval, and literal find inside one document have distinct labels. Content retrieval uses the active index and is cancellable. Document find behaves like Ctrl+F and calls no AI.

Material cards show processing status, warnings, and a next action. The reader loads one page/segment and a bounded text window. Find results show snippets and exact positions; selecting a match loads and highlights its window. Empty results and the broad-query cap are explicit.

Before publication an editor compares the extraction with the original, corrects the visible range, and acknowledges the review. Original files and other text remain unchanged. Published corrections use a separate candidate version with copied assets; readers retain the active version until the candidate is indexed. No repeated OCR/ASR/generation is needed for correction copies.

Lists use permission-filtered metadata in a fixed number of database queries, without full transcript bodies. Personal attachments appear only within their conversation.

## Maintenance and system health

Company maintenance groups jobs, current-format backups/restore, audit, processing/retention, and queue pauses. Accepted jobs survive page closure. An uncertain paid call requires explicit retry after inspecting provider usage.

System health reports storage, workers, PDF/OCR/media dependencies, and resources. One refresh checks dependencies directly. The companies tab manages company lifecycle; the company header selector changes the working membership.

Loading, empty data, disabled models, missing keys, unavailable services, and access denial have separate states. Errors carry diagnostic IDs without exposing credentials or protected content. Missing weights, obsolete media runtimes, and unsupported codecs identify an operator action.

Tabs support arrow/Home/End navigation and Enter/Space activation. Dialogs manage focus. Unsaved-form tracking stores identifiers, not field values, and protects navigation across pages, tabs, companies, and dialogs.
