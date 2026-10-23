# Сервер Node.js

API, обработчики и CLI используют общие сервисы приложения и публичный контракт. PostgreSQL хранит данные и задания pg-boss, S3 — неизменяемые оригиналы и производные медиа. Redis — восстанавливаемый кеш. Рабочая роль БД не обходит RLS; инициализация схемы выполняется отдельным административным подключением.

[Архитектура](../docs/ARCHITECTURE.md) · [API](../docs/API.md) · [CLI](../docs/CLI.md) · [Разработка](../docs/DEVELOPMENT.md) · [Эксплуатация](../docs/OPERATIONS.md)

Схема версии 7 несовместима с прежними данными. Старых SQLite/HuggingFace-реализаций и адаптеров API в текущей архитектуре нет.

`src/application/application.ts` проверяет и направляет публичные действия. `features/knowledge-bases/knowledge-base-service.ts` управляет правами и изменениями баз; `features/operations/retention-service.ts` — сроками хранения и очисткой. HTTP и CLI применяют одинаковые правила.

Python/Swift для PDF/OCR находятся в `resources/extraction/` и включаются в production-образ. Команды подготовки и сборки — в корневом `tooling/server/`. Запускайте их через package scripts; пути не зависят от каталога вызова.

[Учебные материалы](../examples/knowledge-base/README.ru.md) находятся вне серверного кода. `.cache` хранит управляемые инструменты и веса, `.venv` — зависимости Python; это рабочие локальные зависимости, не исходные данные базы знаний.

[English](README.md)
