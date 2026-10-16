# Развёртывание и эксплуатация

## Docker Compose

Установите Docker Engine и Compose plugin по официальной инструкции для дистрибутива. Не открывайте наружу PostgreSQL, Redis, S3 или Docker socket. На macOS используйте Docker Desktop; его Linux VM — часть работы контейнеров, а не отдельный клиентский сервер.

Скопируйте исходники/lockfile, установите Node.js для команд настройки или создайте приватный .env по примеру. На новой машине:

```sh
yarn install --immutable
yarn configure --production
# Edit .env: TLS_DOMAIN, DOCKER_PUBLIC_ORIGIN and RAG_PUBLIC_ORIGIN.
# After bootstrap, add provider API keys in the owner admin.
docker compose --env-file .env -p local-rag-saas-app -f compose.yaml -f compose.production.yaml --profile app up -d --build --wait
```

Задайте реальный домен и DNS, указывающий на сервер, откройте 80/443. Caddy выпускает и хранит TLS-сертификаты; Nginx отдаёт клиент и проксирует API/SSE без буферизации. compose.production.yaml убирает публикацию HTTP-порта клиента. Не используйте демонстрационные секреты и seed в production.

Создайте первого оператора через stdin:

```sh
read -s OPERATOR_PASSWORD
printf '%s' "$OPERATOR_PASSWORD" | docker compose --env-file .env -p local-rag-saas-app --profile app exec -T api node server/dist/interfaces/cli/main.js bootstrap admin --name 'My Company'
unset OPERATOR_PASSWORD
```

В админке владельца добавьте ключ в реестр API-ключей и выберите его в профиле модели. Настройте актуальные цены, модель и лимиты, выполните проверку подключения. Сохранение, замена и отключение ключей сразу применяются к новым вызовам API и воркеров. Значения ключей шифруются в PostgreSQL; APP_ENCRYPTION_KEY храните отдельно от БД. Полный снимок установки содержит зашифрованный реестр, копия компании — нет. Не вводите ключ в поле имени модели или endpoint. Для Ollama добавьте endpoint в AI_ALLOWED_ENDPOINTS; контейнерный API не видит localhost вашего Mac как свой localhost. Можно направить его на выделенный сервер моделей, host.docker.internal или опциональный Compose-профиль.

Все контейнеры server используют read-only root и временный /tmp; API и workers работают непривилегированным пользователем node. S3/PostgreSQL имеют постоянные тома; Redis — вытесняемый кеш без обязательного persistence. Изменение лимита компании не меняет жёсткие memory/CPU пределы контейнера. Масштабируйте workers по очередям и отслеживайте connection budget PostgreSQL: каждый API/worker имеет свои pools.

PDF/OCR helpers в образе находятся в `server/resources/extraction/`; каталог `server/scripts` больше не используется. Сборка копирует необходимые ресурсы отдельно от TypeScript. Учебный корпус `examples/knowledge-base` и `.artifacts/` исключены из build context: это не production-данные. Чтобы загрузить демонстрацию, запускайте [импорт через API](../examples/knowledge-base/README.md) из checkout с выбранной CLI-компанией.

## Состояние и обновление

/health/live проверяет процесс; /health/ready — соединение PostgreSQL и состояние кеша. Административная диагностика отдельно проверяет S3, workers, FFmpeg/Whisper/PDF/OCR. Не путайте liveness с доступностью платной модели. Задания/операции показывают очередь, ошибки, бюджет и активные workers. OpenTelemetry включается OTEL_EXPORTER_OTLP_ENDPOINT; SQL параметры и тексты документов не включены в enhanced reporting.

При проблеме материала проверьте его задание/diagnostic ID, состояние worker, затем соответствующий PDF/OCR/media runtime и назначенную модель. При проблеме ответа отдельно проверяйте модель генерации, активный поисковый индекс, опубликованные источники, права и бюджет. Доступный HTTP endpoint модели сам по себе не подтверждает готовность поиска. Пользовательский порядок действий приведён в [USAGE](USAGE.md).

Перед несовместимым обновлением сохраните копию, остановите приложение и подготовьте новую совместимую установку. Схема версии 7 привязана к текущему контракту: старые базы/копии отклоняются, автоматической миграции нет. Данные разработки пересоздаются guarded reset. Не пытайтесь заменить только API, оставив клиент и workers другого релиза.

## Резервная копия компании

В админке или CLI: backup.create → дождаться задания → backup.verify → backup.restore → дождаться восстановления. Копия находится в S3, включает consistent PostgreSQL snapshot и отдельные копии immutable assets. HMAC с APP_ENCRYPTION_KEY и SHA-256 защищают текущий формат/целостность. Restore закрывает операции только целевой компании, отменяет её активные задания, не заменяет глобальные пароли и не затрагивает другие компании. Недоступные источники скрываются из истории.

Автоматические backup/cleanup запускает maintenance worker. backupIntervalHours=0 отключает плановое копирование; backupDays задаёт retention. Очистка удаляет просроченные незавершённые загрузки, историю/задания/аудит по срокам и отложенные S3-объекты. Не храните единственную аварийную копию на том же диске.

## Полная аварийная копия установки

Только оператор, для локального S3 в Compose. Команда останавливает API, workers и storage на время снимка, PostgreSQL остаётся для pg_dump. Она не требует установленного на хосте PostgreSQL.

```sh
# Docker CLI must be in PATH; INSTALLATION_PROJECT defaults to local-rag-saas-app.
yarn installation:backup /secure/new-snapshot-directory
# Store private .env separately; protect snapshot files as confidential data.
# Restore only into the selected, initialized installation with the same private .env:
yarn installation:restore /secure/new-snapshot-directory --confirm-replace-installation
```

Снимок содержит postgres.dump, storage.tar и manifest.json со схемой/хешами. Секреты не копируются автоматически. Доступ к каталогу — 0700, файлы — 0600; перемещайте копию в отдельное защищённое хранилище. Restore заменяет выбранную установку; используйте только доверенные операторские snapshots текущего формата. Для внешнего S3 нужна согласованная стратегия snapshot/versioning у поставщика, локальный filesystem script для него неприменим.

При аварии после отправки AI-запроса провайдер мог списать деньги. Такие задания сохраняются с неопределённым результатом; проверьте usage у поставщика перед ручным retry. Redis outage не требует восстановления бизнес-данных. Длительная недоступность PostgreSQL/S3 должна сопровождаться остановкой приёма/восстановлением зависимости, а не созданием нового tenant с теми же именами.

## Локальные модели

Для сервера моделей можно добавить Ollama рядом с приложением. На Linux GPU подключается отдельно средствами NVIDIA/ROCm; на Mac контейнер не получает Metal автоматически. На Mac для Metal укажите доступный host endpoint, а обработчики/whisper.cpp остаются серверными компонентами продукта. Требуемые модели загружаются в выбранный runtime; их availability проверяйте models.check. Замена провайдера генерации не перестраивает vectors; смена embedding space требует indexes.build/activate.

Обычная копия компании использует формат tenant-data-v2. При восстановлении сохраняются текущий журнал расходов, квоты оператора и каталог моделей. Старые расходы не обнуляются; цены и отозванные подключения не возвращаются из копии. Если прежний embedding-профиль больше недоступен, оператор выбирает доступный профиль и перестраивает индекс. Полный операторский снимок установки сохраняет все таблицы и предназначен для аварийного восстановления, а не для отката бюджета компании.

## Перенос локальных моделей

A local deployment uses compose.yaml plus compose.local-ai.yaml; add compose.production.yaml for the public HTTPS gateway. For example: `docker compose --env-file .env -f compose.yaml -f compose.local-ai.yaml -f compose.production.yaml --profile app up -d --build --wait --wait-timeout 3600`. `yarn docker:up` selects the local overlay automatically when LOCAL_AI=1; domain/HTTPS configuration remains an operator deployment choice.

Keep the private .env, PostgreSQL and S3 snapshots, and the repository/deployment files. Ollama software and Whisper executable/weights come from versioned images. Qwen/EmbeddingGemma weights live in the Compose project's ollama-data volume. Database/S3 installation snapshots do not include that model volume: stop Ollama, export/import the volume separately for an offline move, or let the initializer download the models on the new server. Existing volumes are reused without pulling updated tags. If downloading tags again yields different weights, rebuild embedding indexes before serving retrieval against them. Model digests shown by `ollama list` should be recorded for a reproducible transfer.

Moving only the source folder does not transfer customer data, private .env or Docker volumes. No manual installation of Ollama, FFmpeg or Whisper on the destination host is needed. Docker/Compose, adequate RAM/disk and (for initial downloads) Internet are required. Linux NVIDIA acceleration additionally requires a compatible GPU/runtime and a GPU Compose override; the default portable deployment is CPU.
