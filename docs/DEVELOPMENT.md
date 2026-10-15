# Разработка

Начните с [установки и первого запуска](../README.ru.md). Все команды ниже выполняются из корня. `yarn` — закреплённый Yarn 4.18.1; без глобального launcher используйте `node .yarn/releases/yarn-4.18.1.cjs`. Конфигурация описана в [CONFIGURATION.md](CONFIGURATION.md), развёртывание и Docker — в [OPERATIONS.md](OPERATIONS.md).

## Владельцы файлов

| Каталог                           | Назначение                                                              |
| --------------------------------- | ----------------------------------------------------------------------- |
| `client/src`, `client/tests`      | React/MobX, экраны, API-клиент, UI и клиентские тесты                   |
| `client/scripts`, `client/deploy` | Сжатие assets, Node gateway, nginx, образ и служба клиента              |
| `server/src`, `server/tests`      | HTTP/SSE, прикладные сервисы, SQLite, модели, CLI и серверные тесты     |
| `server/scripts`, `server/deploy` | Launchers, подготовка PDF/OCR, live-тест, benchmark, образ и службы API |
| `tooling`                         | Общие команды configure, contracts, docs:check, dev/start и supervisor  |
| `docs`, `.github`, `compose.yaml` | Документация, CI и композиция двух сервисов вне исходников              |
| `client/dist`, `server/dist`      | Генерируемые браузерная и серверная сборки; исключены из Git            |
| `server/data`                     | Данные, блокировка writer, локальные ключи и копии по умолчанию         |
| `server/.cache`, `server/.venv`   | Модели, Python wheels, OCR и изолированный PDF runtime                  |

Корневого `dist` нет. Два workspace `dist` имеют разных потребителей и воспроизводятся сборкой. Исходники приложения — TypeScript/TSX; Python и Swift обслуживают локальный PDF/OCR. JavaScript в сборках, зависимостях и закреплённом Yarn не переводится вручную. Структуру модулей и допустимые зависимости описывает [архитектура](ARCHITECTURE.md).

## Команды

| Команда                                                | Действие                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `yarn configure`                                       | Создать отсутствующие server/.env, client/.env, compose.env из примеров; существующие сохранить |
| `yarn dev`                                             | Обновлять контракт, запускать watched API и Vite с Fast Refresh                                 |
| `yarn dev:client`, `yarn dev:server`                   | Запустить workspace отдельно                                                                    |
| `yarn cli help`                                        | Справка CLI; полный список — [CLI.md](CLI.md)                                                   |
| `yarn prepare:pdf`                                     | Установить локальные зависимости PDF/OCR; режимы — [конфигурация](CONFIGURATION.md#pdf-и-ocr)   |
| `yarn build`, `yarn build:client`, `yarn build:server` | Собрать оба приложения или выбранное                                                            |
| `yarn start`, `yarn start:client`, `yarn start:server` | Запустить готовые сборки вместе или отдельно                                                    |
| `yarn contracts:generate`, `yarn contracts:check`      | Сгенерировать DTO/подпись формата или проверить их актуальность                                 |
| `yarn docs:check`                                      | Проверить ссылки и покрытие справочников документации                                           |
| `yarn typecheck`                                       | Проверить TypeScript корня и обоих workspace                                                    |
| `yarn lint`, `yarn lint:fix`                           | Проверить ESLint или применить исправления                                                      |
| `yarn format`, `yarn format:check`                     | Применить Prettier или проверить формат                                                         |
| `yarn test`, `yarn test:product`                       | Все автоматические тесты или серверные продуктовые сценарии                                     |
| `yarn test:product:live`                               | Сквозной сценарий с настоящими локальными моделями и PDF/OCR                                    |
| `yarn benchmark`                                       | Изолированные измерения SQLite/поиска без inference                                             |
| `yarn validate`                                        | docs:check → contracts:check → typecheck → lint → format:check → test → build                   |

`yarn dev` открывает клиент на **http://127.0.0.1:5173/**, API — на 3210. Vite проксирует `/api` и `/health`. API не отдаёт HTML. Занятый порт вызывает ошибку. Ctrl+C завершает дочерние процессы этой команды. Watcher ждёт завершения сервера до повторного запуска; ошибка старта не отключает наблюдение. Работающие задания после остановки помечаются прерванными; сохранённые результаты и очередь остаются в SQLite.

Для телефона задайте `CLIENT_DEV_HOST=0.0.0.0`, оставив API на loopback. Первого администратора создавайте локально. На удалённом HTTP-адресе браузер может запретить Clipboard API и Web Crypto; для полноценной проверки используйте HTTPS или localhost. Отдельный `yarn workspace @local-rag/client preview` открывает сборку на 4173 и проксирует API; для эксплуатации используйте gateway или nginx.

Не запускайте dev и production API одновременно на одном каталоге данных. Для параллельной проверки задайте отдельные абсолютные `RAG_DATA_DIR`, порты и клиентский API target. Не удаляйте рабочие данные для прохождения тестов: автоматические проверки создают собственные временные установки.

## Контракт и зависимости

[contracts/public.ts](../server/src/contracts/public.ts) — единственный источник DTO, API actions и допустимых полей. Генерируемые клиентская копия и подпись формата входят в Git. После изменения выполните `yarn contracts:generate`. Общий dev supervisor отслеживает контракт; независимые workspace-команды этого не делают. Подпись текущего контракта участвует в проверке схемы данных: даже изменение DTO может потребовать пустой dev-каталог. Правила совместимости — в [AGENTS.md](../AGENTS.md).

Runtime-зависимости объявляются у владельца: React/MobX/Markdown у клиента, Transformers/ONNX и парсер текста у сервера. Vite/Vitest — клиентские devDependencies, tsx — серверная. TypeScript и Node types объявлены в каждом workspace, где используются; корень содержит общие инструменты. Один lockfile и hoisting Yarn устраняют физические дубли, не меняя границ приложения.

`tooling/*.ts` и launchers используют выполнение стираемого TypeScript в Node 24. Серверные исходники компилируются `tsc`; разработка и тесты используют tsx. `eslint.config.ts` проверяется TypeScript и загружается dev-зависимостью jiti. Production API не требует tsx или компилятора; Node gateway после сборки использует стандартную библиотеку.

## Как проверять изменение

Выберите тесты затронутой функции, затем выполните `yarn validate`. Для API/DTO обновляйте сервер, клиент, CLI, справочник API и проверки вместе. Для изменений retrieval, промпта, модели или индекса дополнительно нужны контрольные вопросы и live-сценарий. Для UI проверяйте клавиатуру, фокус, мобильный viewport, ошибки и пустые состояния.

Состав проверок, необходимые зависимости, формат протоколов и ограничения измерений — в [VERIFICATION.md](VERIFICATION.md). CI выполняет immutable install, validate, обе сборки и отдельную сборку двух контейнеров без публикации. Наличие workflow не означает успешного выполнения Docker на вашей машине; службы и TLS проверяются на целевой установке.
