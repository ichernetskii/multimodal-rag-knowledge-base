# Sample knowledge base

Nine fixed materials for checking the UI, extraction, retrieval, and citations. Policies and service data are fictional, not instructions for a real organization. Inputs live outside application code, runtime storage, and generated test results.

## Import

1. Start the application and workers, run `yarn cli login admin`, then `yarn cli tenant-use COMPANY_UUID`.
2. Run `yarn demo:import`. It verifies every SHA-256, creates a new sample knowledge base in the selected company, and uploads through the public API. A company administrator grants user/group access; there are no initial user grants.
3. Open the materials, compare extracted text, OCR, image descriptions, and transcripts with the originals, then publish. Wait for indexing.
4. Ask the questions in [manifest.json](manifest.json), inspect citations, and compare the expected facts. Also check revoked access and personal attachments.

`yarn demo:import --publish` explicitly acknowledges publication of sample data without manual review. Configured AI profiles may contact providers and consume budget. Each run creates a new base; it does not replace existing materials. A partial failure exits with code 1 and reports the base, file, job ID, and diagnostic; accepted data remains available for inspection. `seed` creates development accounts and companies, not hidden sample publications.

## Coverage

| Material                               | What it checks                                                    |
| -------------------------------------- | ----------------------------------------------------------------- |
| [company.md](text/company.md)          | Markdown, headings, 14/21-day leave policies, expenses, equipment |
| [it.txt](text/it.txt)                  | UTF-8 text; laptop issued on the first working day                |
| [text.pdf](pdf/text.pdf)               | PDF text layer; E-42 / 12 Nm                                      |
| [scan.pdf](pdf/scan.pdf)               | Scan OCR; E-43 / 3 litres                                         |
| [mixed.pdf](pdf/mixed.pdf)             | Text and scan in one PDF; sources from both pages                 |
| [tables.pdf](pdf/tables.pdf)           | Table row A-100/B / 12 Nm / E-42                                  |
| [label.png](media/label.png)           | Image of the AX-100 service label                                 |
| [jfk.wav](media/jfk.wav)               | English speech, audio source, and time boundaries                 |
| [inspection.mp4](media/inspection.mp4) | H.264/AAC video; separate visual and audio tracks                 |

The video is static: it checks both processing paths, not motion understanding. The manifest records modality, size, SHA-256, question, and expected facts. Expected facts guide human evaluation rather than requiring a model's exact wording.

## Providers and limits

TEST AI verifies infrastructure and does not establish image understanding or answer quality. Text embeddings require an image-capable answer model for descriptions and Whisper or Google Gemini for speech. Review generated representations before publication. Native multimodal profiles must declare only inputs the actual model supports. PDF/OCR requires the prepared runtime. Provider and budget failures stay visible as material/job errors.

`yarn test` checks corpus integrity and modality coverage. `yarn test:docker` uses these files with real PDF/OCR, image, Whisper, and video processing. When changing an input, update its hash, size, expected facts, and relevant assertions. Generated runs belong in ignored `.artifacts/verification/`.

## Provenance

Texts, PDFs, and the label are synthetic project materials. Speech comes from whisper.cpp 1.9.1 test samples; its [MIT license](media/WHISPER-LICENSE.txt) is included. The video combines the included label and speech:

```sh
ffmpeg -v error -loop 1 -i examples/knowledge-base/media/label.png \
  -i examples/knowledge-base/media/jfk.wav -vf 'scale=640:-2' -shortest \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart -threads 1 \
  examples/knowledge-base/media/inspection.mp4
```

Rebuilding the video is optional; imports and tests use the checked-in file.

[Russian README](README.ru.md)
