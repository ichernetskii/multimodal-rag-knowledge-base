# Web client

The React, Vite, TypeScript, and MobX client for **Multimodal RAG Knowledge Base**. `src/app` composes the application and stores; `src/features` contains workflows; `src/shared` contains UI components, the HTTP client, and generated contracts.

Run these commands from the repository root:

```sh
yarn dev:client
yarn build:client
yarn workspace @local-rag/client test
```

Vite proxies API/SSE requests to the server in development. Production assets are bundled locally without a CDN. Run `yarn contracts:generate` after editing `server/src/contracts/public.ts`; the browser never imports server implementations.

`yarn start:client` serves the production build through the Node gateway on port 8080. The container uses nginx. See [configuration](../docs/CONFIGURATION.md#client), [development](../docs/DEVELOPMENT.md), and [deployment](../docs/OPERATIONS.md).

Navigation scopes and permissions live in `src/features/admin/admin-sections.ts`. Company settings, company model connections, and the platform credential vault have explicit scopes. Menu visibility complements server authorization. An unavailable selected model is shown explicitly; the client does not silently select another model. Model availability and active index status are separate.

See [application usage](../docs/USAGE.md) and [admin workflows](../docs/ADMIN-UX.md) for the implemented workspace, review, document reader, and role boundaries.

[Russian README](README.ru.md)
