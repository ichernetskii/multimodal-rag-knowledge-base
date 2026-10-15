# Local RAG

An offline document library with chat, local search, users and administration. React + Vite + TypeScript + MobX live in `client/`; the Node.js + TypeScript API, SQLite, background jobs and CLI live in `server/`. The browser and CLI use the same authorization and validation.

This is a development project with no public release. There is one current API and data format; incompatible data and backups are rejected, without migration. See [development rules](AGENTS.md).

## Quick start

Requirements: Node **24.19.0** ([.nvmrc](.nvmrc)), Python 3.10+, and a local Ollama installation. PDF OCR needs Xcode Command Line Tools on macOS or Tesseract and its language packs on Linux. Run Ollama before pulling the generation model.

From the repository root:

```sh
node .yarn/releases/yarn-4.18.1.cjs install --immutable
yarn configure
yarn cli setup
yarn prepare:pdf
ollama pull qwen3.5:4b
yarn dev
```

`yarn` in these instructions means the pinned Yarn **4.18.1**. If there is no `yarn` command on your machine, replace it with `node .yarn/releases/yarn-4.18.1.cjs` from the repository root. `cli setup` prepares embedding weights; it does **not** create an administrator.

Open **http://127.0.0.1:5173/**. Complete the local first-run wizard, create a knowledge base, upload a document, wait for indexing and ask a question. PDF pages recognized with OCR require review before publication. Supported inputs: PDF, UTF-8 TXT and Markdown (`.md`, `.markdown`). No sample accounts or documents are installed automatically.

Preparation can require internet access. Once dependencies, embedding weights, OCR and the selected Ollama model are ready, normal operation uses local resources only. For a production build, stop development first, then run `yarn build` and `yarn start`; the client opens on **http://127.0.0.1:8080/**. The API listens on port 3210 and does not serve HTML.

## Capabilities and boundaries

- Users chat and read permitted sources; editors manage assigned knowledge bases; administrators manage access, settings, quality, backups and operations.
- Hybrid search combines semantic retrieval, full-text search and exact identifiers. Citations retain document versions, pages and sections. Private conversation attachments remain private.
- Chat drafts, question variants, selected branches and job state are saved on the server. Markdown is rendered without executing HTML or scripts.
- SQLite online backups include documents, users, processing configuration, history and jobs. Model weights and deployment environment files are prepared separately.

The server has one SQLite writer. Search scans permitted vectors; an ANN index and multi-server shared storage are not implemented. OCR and factual quality need human review. Quality checks compare configured sources and expected phrases; they do not prove arbitrary answers correct.

## Documentation and checks

- [Russian quick start](README.ru.md)
- [Documentation index](docs/README.md): usage, development, configuration, CLI, API and operations
- [Architecture](docs/ARCHITECTURE.md)
- [Verification and known limits](docs/VERIFICATION.md)
- [Requirements matrix](docs/REQUIREMENTS.md)

`yarn validate` checks documentation, generated contracts, types, lint, formatting, tests and both builds. `yarn test:product:live` additionally uses real local models and the [four PDF fixtures](server/tests/fixtures/pdf/README.md) in an isolated temporary installation. Neither command seeds the working application.
