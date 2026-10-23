# Веб-клиент

Клиент **Multimodal RAG Knowledge Base** на React, Vite, TypeScript и MobX. `src/app` собирает приложение и хранилища, `src/features` содержит пользовательские сценарии, `src/shared` — UI, HTTP-клиент и сгенерированные контракты.

Команды из корня репозитория:

```sh
yarn dev:client
yarn build:client
yarn workspace @local-rag/client test
```

Vite проксирует API/SSE в разработке. Production использует локальные assets без CDN. После изменения `server/src/contracts/public.ts` выполните `yarn contracts:generate`. Клиент не импортирует серверные реализации.

`yarn start:client` запускает собранный клиент через Node gateway на порту 8080; контейнер использует nginx. [Конфигурация](../docs/CONFIGURATION.md#client), [разработка](../docs/DEVELOPMENT.md), [развёртывание](../docs/OPERATIONS.md).

Области навигации и права определены в `src/features/admin/admin-sections.ts`. Настройки компании, её подключения моделей и общее хранилище ключей разделены. Видимость меню не заменяет авторизацию сервера. Недоступная выбранная модель показывается явно; первая доступная модель не подставляется автоматически. Готовность индекса и доступность модели — отдельные состояния.

[Работа с приложением](../docs/USAGE.md) · [Административные сценарии](../docs/ADMIN-UX.md) · [English](README.md)
