# Using the application

Sign in and select a company in the header. Only active memberships are listed. The company name above the page identifies the scope. Platform pages hide the company selector and display **All companies**. Navigation stays in place; the footer shows your account and actual role. There is no demo role switcher.

## First workflow

1. A company administrator creates a base under **Knowledge base → Knowledge bases and access**, then grants access to users or groups. Without grants, the base is accessible to company administrators.
2. Under **AI & models → Model assignments**, choose permitted answer and transcription profiles. Prepare and activate the search model separately. The platform owner configures connections.
3. An editor with edit access uploads files in **Materials**. Processing runs as a durable job; the page can be closed.
4. Open the material for review, compare the result with the original, correct extraction errors, acknowledge the review, and publish.
5. Wait for indexing. Search and answers can now use the material for people with access to its base.

Try the [sample corpus](../examples/knowledge-base/README.md) with `yarn demo:import` after CLI login and company selection. It creates a separate base containing text, PDFs, scans, tables, an image, audio, and video. Materials initially await review. The sample's equipment terminology does not limit the product to a particular industry.

## Roles and scopes

| Permission                  | Scope                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| User                        | Conversations, published materials in permitted bases, own personal attachments                                          |
| Editor                      | Also upload, review, correct, publish, and connect folders for bases with edit access                                    |
| Company administrator       | Company bases, team, grants, model assignments, costs, jobs, backups, and settings                                       |
| Platform owner (`operator`) | Separate permission: shared provider keys, diagnostics, company lifecycle, model connections, and increased entitlements |

The `admin` role applies within a company and cannot appoint a platform owner. Operator permission does not grant access to other people's private chats or attachments. Readers cannot see drafts, excluded materials, or unpublished replacements. Editors without edit access have reader permissions for that base. Revoking edit access hides its drafts and folder connector metadata.

| Company section | Tasks                                                              |
| --------------- | ------------------------------------------------------------------ |
| Knowledge base  | Materials, knowledge bases and access, folder sync, answer quality |
| AI & models     | Assignments; connected models for the platform owner               |
| Team & access   | Members, invitations, groups                                       |
| Usage & limits  | AI budget, usage by model/modality, storage, quotas                |
| Maintenance     | Jobs, backups, audit log, processing and retention settings        |

Platform navigation contains **API keys** and **System health**. The company management tab creates, renames, and suspends companies. Use the header selector on company pages to work within a membership.

## Materials and long documents

The filename filter changes the material list. Content search finds words and meaning in accessible published materials without generating an answer. A cloud embedding model may consume budget. Search can be cancelled; changing the knowledge base cancels the request and clears old results.

**Find in this document** looks for a literal word, phrase, or code in the selected version. It works like Ctrl+F without AI or cost. Results show the page/segment and surrounding text; selecting one opens the match with highlighting. Ctrl+F or ⌘F opens this field while the reader is active. Broad searches stop at 10,000 matches and ask for a narrower query.

Long text loads in windows of up to 12,000 characters. Previous/next text controls move within the same page; the page/segment selector is separate. Media previews can be checked alongside extracted text. Version comparison also uses bounded windows.

Before publication, edit the processing text to correct OCR, descriptions, or transcripts. Only the open range changes; the rest of the page and original file remain intact. Review must be acknowledged again after an edit.

For a published error, choose **Create correction version**. The server copies the original and derivatives into an independent review version without repeating OCR, transcription, or paid description generation. Edit and publish that candidate. Search continues using the published version until successful publication/indexing. Finish any existing candidate first. Storage or copy failures are visible in the job.

Personal attachments stay in their conversation. They never enter the company's shared library, including for administrators. Attachment lists are paginated; up to three main files can be selected for the next question.

## Models and speech recognition

Answer, search, and recording transcription profiles are assigned independently. The answer model also generates image descriptions when required and supported. Changing the search model builds a candidate index: wait, inspect the materials/results, then activate it. The previous index remains active until then. A corpus change during a build requires rebuilding.

A new text index automatically prepares missing descriptions or transcripts with the company's selected processing models. Saved text is reused when switching models. Missing credentials, unavailable models, or insufficient budget produce a job error and leave current search active. See [multimodal processing](MEDIA.md).

Recording transcription converts speech in uploaded audio/video into text. Whisper small runs on the installation server; Google Gemini receives audio through its API. Transcription is optional for native audio retrieval and required for text embeddings. Microphone dictation of search questions is not implemented.

The owner creates a Google transcription profile in connections, selects a Google key, sets current prices/limits, enables it, and checks availability. The administrator then assigns it for recording transcription. Local Whisper is chosen through the same assignment. A change affects new jobs; existing transcripts remain saved.

## Connections and provider keys

Model profiles belong to the selected company. **On your server** groups Ollama and Whisper. Ollama needs the server URL and an already installed model; saving a profile does not install weights. Whisper small is bundled in the server image; language/CPU settings belong to company processing. **External API** groups Google, Anthropic, and compatible endpoints. A compatible API can also run on your own server. **Development & verification** contains deterministic TEST AI profiles.

The editor offers only tasks and input types implemented by the adapter. Capability checkboxes must match the actual model. Endpoints must be allowed by deployment configuration. Advanced settings cover context, input size/duration, concurrency, timeouts, rate limits, and prices. Clone an embedding profile already used by an index instead of changing its semantic identity.

Provider keys live under **Platform → API keys**. Values are encrypted and never returned after saving. Connections reference a key from the same provider. Rotation/disable applies to subsequent API and worker calls without a restart; in-flight calls can finish. A blank replacement keeps the saved value. Delete only after removing all profile references. Deleting a key here does not revoke it at the provider. Audits exclude values.

## Maintenance and errors

Company maintenance includes jobs, current-format backups, audit, processing/retention, and queue pauses. System health checks shared dependencies and workers; refresh performs the check directly.

| Symptom                         | Next step                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Material awaits review          | Compare with the original, correct text, acknowledge, publish                                     |
| No key or disabled profile      | Ask the platform owner to configure the connection                                                |
| Ollama model unavailable        | Install it on the configured model server, then recheck                                           |
| Candidate index cannot activate | Wait for completion; rebuild after corpus changes                                                 |
| Job queued                      | Check company pauses, budget, and limits; owner checks workers                                    |
| Uncertain provider outcome      | Inspect provider usage before explicitly retrying                                                 |
| Save conflict                   | Reload the current revision and reapply the edit                                                  |
| Incomplete model answer         | Check the output limit and provider connection, then explicitly retry; a new call may cost money. |
| Provider HTTP redirect rejected | Ask the owner to configure the final approved model endpoint.                                     |

Errors include diagnostic IDs without exposing provider responses or other companies' data. Unsaved forms are protected during navigation, tab/company changes, and dialog closure. Revoked access or an ended session clears protected data regardless of unsaved edits.
