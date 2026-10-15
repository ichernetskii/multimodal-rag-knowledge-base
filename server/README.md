# Сервер

Node.js + TypeScript, SQLite/FTS5, локальный embedding и Ollama. `src/app` — запуск процесса; `src/application` — композиция/планировщик/порты; `src/features` — прикладные сервисы; `src/infrastructure` — адаптеры; `src/interfaces` — HTTP/SSE и CLI.

```sh
# Из корня проекта:
yarn dev:server
yarn build:server
yarn cli help
yarn workspace @local-rag/server test
```

Все обычные CLI операции используют API работающего сервера. SQLite имеет единственную текущую схему без миграций старых форматов. [Правила](../AGENTS.md), [архитектура](../docs/ARCHITECTURE.md), [API](../docs/API.md), [эксплуатация](../docs/OPERATIONS.md).

`yarn start:server` запускает compiled API; он не раздаёт интерфейс. `yarn cli setup` готовит embedding, `yarn cli serve` запускает API, а первого администратора создаёт локальный мастер или setup.create. Команды и исключения офлайн-доступа — в [CLI.md](../docs/CLI.md); env и лимиты — в [CONFIGURATION.md](../docs/CONFIGURATION.md).

В [examples/](examples/) находятся небольшие файлы для ручной загрузки: [политики компании](examples/company.md) и [IT-инструкция](examples/it.txt). Они не загружаются автоматически. Фиксированные PDF для сквозного теста хранятся отдельно в [tests/fixtures/pdf/](tests/fixtures/pdf/).
