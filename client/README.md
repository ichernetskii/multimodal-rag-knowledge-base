# Клиент

React + Vite + TypeScript + MobX. `src/app` собирает приложение и передаёт хранилища через provider; `src/features` содержит отдельные функции; `src/shared` содержит общие UI, HTTP-клиент и генерируемые DTO.

```sh
# Из корня проекта:
yarn dev:client
yarn build:client
yarn workspace @local-rag/client test
```

API/SSE в разработке проксируются Vite на сервер. В production используются локальные assets без CDN. Контракт генерируется командой `yarn contracts:generate`; изменения выполняются в серверном `contracts/public.ts`. [Архитектура](../docs/ARCHITECTURE.md), [разработка](../docs/DEVELOPMENT.md).

`yarn start:client` запускает самостоятельный Node gateway на 8080 после сборки. В контейнере assets обслуживает nginx; серверные модели и зависимости в образ клиента не входят. Настройки Vite/gateway описаны в [CONFIGURATION.md](../docs/CONFIGURATION.md#клиент), TLS и службы — в [OPERATIONS.md](../docs/OPERATIONS.md). Поведение чата и админки — в [USAGE.md](../docs/USAGE.md).
