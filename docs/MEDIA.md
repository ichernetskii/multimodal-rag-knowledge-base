# Multimodal processing and speech recognition

Knowledge materials and personal attachments use the same server pipeline. `documents.limits` reports supported extensions. Originals remain immutable in private S3; derived images, clips, audio, and text belong to a specific version.

The [sample corpus](../examples/knowledge-base/README.md) covers Markdown/TXT, text PDF, scanned PDF, mixed PDF, tables, PNG, WAV, and MP4. Import with `yarn demo:import`, review, and publish. Its static video does not test motion understanding.

## Two retrieval paths

The company's active embedding profile determines how search represents media:

| Path                         | What is embedded                                        | Required processing                                                          |
| ---------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Text embeddings              | Extracted text, image descriptions, speech transcripts  | An image-capable answer model for descriptions; selected ASR for speech      |
| Native multimodal embeddings | Supported image/audio/video content plus available text | Media decoding; descriptions need not exist; ASR is optional unless assigned |

A text question can retrieve an image or recording through native multimodal vectors without a manually written description. Search also combines vector, lexical, and technical-code matches, with permission filtering before results are returned. A visible transcript does not imply text-only retrieval.

PDFs are processed as text/OCR and individual page images even if a provider adapter supports a whole PDF. Images are decoded and normalized to JPEG. Audio becomes bounded mono PCM16/16 kHz segments. Video produces bounded visual clips, previews, and separate audio segments; visual and audio tracks are indexed separately.

Google native profiles receive the supported binary modality encoded for the API transport. A caption does not replace its content. The index stores vectors and provenance references; answers return text with citations and media previews.

The chat combines the question with supported media from the first page of a personal attachment. Answer models receive supported source media or video previews. Full retrieval coverage for a long input video and real cloud model quality require separate evaluation.

## Where descriptions and transcripts come from

A version stores the original, prepared media, and page text. Vectors are a separate representation for one embedding model. Changing models does not delete saved text.

- PDF text/OCR is extracted during upload processing.
- A text embedding profile requires an image or video-preview description. The selected image-capable answer model generates it.
- A native profile can retain only a technical caption identifying the file/segment.
- An assigned ASR profile transcribes audio, including when native retrieval is selected. Without ASR, native audio retrieval can use the audio itself.

When switching from native to text search, the new index job prepares only missing descriptions/transcripts using the selected processing profiles. Existing text is reused across embedding and answer model changes. Failures leave the previous search index active; there is no silent failover to another paid provider.

Additional text is saved in page `preparedText` with its kind, provider, profile, model, and creation time. `documents.read` exposes the saved substantive representation. Reviewer corrections take precedence. Concurrent preparation of a page is serialized and checks the current job attempt and access. A newly uploaded version is processed independently. Text embedding requests do not reupload source media.

The first media chunk receives saved text alongside supported binary content; subsequent text chunks are indexed separately. A single preview cannot establish motion understanding; select a native video model for those tasks. Ollama receives supported images and is not advertised as accepting raw audio/video when it does not.

## Speech recognition

ASR transcribes recordings supplied to the knowledge base or as personal attachments. It does not speak answers or provide microphone dictation for the question field.

| Provider                   | Execution                                | Configuration                                                                         |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| Whisper small multilingual | Installation server, through whisper.cpp | Select the Whisper transcription profile; processing settings control language/CPU    |
| Google Gemini              | Audio is sent to Google through its API  | Google `transcription` profile, enabled provider key, audio input, prices, and limits |

Google Gemini is asked for a verbatim transcript in the original language. Its transcription assignment is independent of embedding and answer models. The specialized Google Cloud Speech-to-Text service with Cloud IAM is not implemented. A personal audio attachment can also supply native audio to retrieval; that is separate from question dictation.

The owner creates the Google profile, then a company administrator assigns it under recording transcription. `DEFAULT_TRANSCRIPTION_PROVIDER=google` applies to new companies only. It does not automatically replace an unavailable Whisper profile. Calls share budget, rate, timeout, concurrency, and usage accounting. Incomplete provider output, including a token-limit stop, is rejected rather than saved as a complete transcript. Review semantic accuracy against the original.

Provider references: [Gemini audio understanding](https://ai.google.dev/gemini-api/docs/audio) and [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing). Defaults in source are configuration examples, not a live price feed or a guarantee that a model is available for an account. Verify the actual model and tariff before enabling paid calls.

## Review and correction

Before publication an authorized editor can change OCR, descriptions, and transcripts with `documents.correct`. It updates the page/range and sections, resets review acknowledgement, and increments document revision. Originals and media stay unchanged; audit excludes text. Processing and publication lock out edits.

For published material, `documents.revise` creates an independent correction candidate by copying original and derived assets. It does not rerun OCR/ASR/generation. Edit, review, and publish that version; current search remains available until the candidate is indexed successfully. The reader uses bounded text windows and displays processing provenance.

## Runtime and playback

Docker includes FFmpeg, whisper.cpp, pinned SHA-verified sources, and small multilingual weights. Native development runs `yarn prepare:pdf` and `yarn prepare:media`. Python PDF extraction/rendering and Swift Apple Vision sources live in `server/resources/extraction/`; preparation scripts live in `tooling/server/`. `.venv` and `.cache` are generated dependencies, not sample documents.

Size, duration, pages, fragments, CPU threads, timeouts, and media count are bounded. Decoder commands run without a shell and use restricted protocols/output/temp paths. Indexing workers have independent CPU/memory limits. Docker on macOS does not automatically expose Metal to Linux models.

The bundled H.264 build includes x264 under GPLv2. License texts and corresponding source archives for FFmpeg/x264/Whisper accompany runtime binaries. Build instructions live in the media installer. Native builds also require `pkg-config`. A short final video segment retains at least one frame with `fps=1:eof_action=pass`; the sample video covers this case.

The browser plays prepared MP4/WAV segments from zero. Captions and original links retain source timestamps. Prepared video previews have a separate audio track, available as audio segments and in the full original. Fractional timestamps distinguish short tail segments.

Image generation is not part of the current contract: output is a text answer with retrieved sources. Adapters reject unsupported tasks. Runtime diagnostics checks current installation receipts, executables, weights, and H.264 support; see [development](DEVELOPMENT.md).
