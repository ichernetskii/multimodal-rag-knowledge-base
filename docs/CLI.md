# CLI

Run `yarn cli help`. CLI uses the same HTTP API, permissions and tenant checks as the browser. The local init/bootstrap/serve/worker/seed/prepare-local/check commands operate on deployment configuration directly. There is no legacy offline database adapter.

```sh
yarn cli init
# Password via stdin, not a shell argument or history:
read -s OPERATOR_PASSWORD
printf '%s' "$OPERATOR_PASSWORD" | yarn cli bootstrap admin --name 'My Company'
unset OPERATOR_PASSWORD

yarn cli login admin
yarn cli tenants list
yarn cli tenant-use TENANT_UUID
yarn cli collections save input.json
yarn cli upload ./manual.pdf COLLECTION_UUID
yarn cli watch JOB_UUID
yarn cli review DOCUMENT_UUID
yarn cli publish DOCUMENT_UUID
yarn cli ask 'How often should XZ-417 be serviced?'
yarn cli ask 'What is shown here?' --file ./photo.jpg
yarn cli search 'XZ-417'
yarn cli download DOCUMENT_UUID ./original.pdf
yarn cli export CONVERSATION_UUID ./conversation.json
```

`login` reads the password from stdin. Credentials are mode 0600 under `~/.local/share/local-rag/cli.json`; use RAG_CLI_FILE to choose a private location. `--url`, `--tenant`, `--json` apply to API commands. Upload progress persists on the server; retry interrupted binary upload with `--upload UPLOAD_UUID`. SHA-256 and length must still match. `ask --file` explicitly processes and publishes the private attachment before asking.

From the project root, `yarn demo:import` reuses the saved CLI session/company and uploads the [checked-in multimodal corpus](../examples/knowledge-base/README.md) into a new knowledge base. It waits for extraction but leaves publication for review. `--publish` acknowledges/indexes demo data explicitly; failures return code 1 with the saved base/job context. Every invocation creates a new base. It uses no separate database/authorization bypass. `seed` creates the development identity/companies only and is prohibited in production.

Administrative actions accept JSON files or stdin: `yarn cli models list`, `yarn cli models save profile.json`, `yarn cli indexes build input.json`, `yarn cli indexes activate input.json`, `yarn cli settings save input.json`, `yarn cli backup create`, `yarn cli backup verify input.json`, `yarn cli backup restore input.json`, `yarn cli usage read`, `yarn cli cache clear`, `yarn cli audit list`, `yarn cli invitations create input.json`. All actions are also available through `yarn cli api ACTION input.json`; input fields are in [API](API.md). The invitation token is shown once; the employee accepts it in the UI or with `yarn cli accept-invite TOKEN` and password on stdin.

`yarn cli sync CONNECTOR_UUID ./directory [--watch]` hashes a local manifest and uploads changes through resumable sessions. The server stores connector metadata, never reads a client filesystem path. Removed-file policy is keep/exclude/delete. New or replaced documents require review/publication. Symbolic links are skipped.

`watch JOB_UUID` reconnects to saved SSE state; waiting does not create another AI call. `cancel` fences the active attempt. `retry` records a new job and requires explicit review for uncertain provider outcomes. `diagnose` and local `check` inspect the configured installation. Whole-installation snapshot commands are in [operations](OPERATIONS.md).

users.revoke завершает глобальные сессии аккаунта и доступен только оператору. Администратор компании может заблокировать членство через users.update; остальные компании сохраняют доступ.

## Проверка моделей

Владелец платформы задаёт отдельные входные ставки (USD за миллион токенов) одной командой:

```sh
yarn cli models pricing PROFILE_UUID --text 0.20 --image 0.45 --audio 6.50 --video 12 --output 0
yarn cli usage read --json
```

Все пять ставок обязательны. Числа в примере иллюстрируют формат, а не подтверждают текущую цену поставщика. Перед включением платного профиля проверьте тариф своего аккаунта. В JSON профиля `inputMicrosPerMillion` — объект `{ "text": 200000, "image": 450000, "audio": 6500000, "video": 12000000 }`. Старое числовое поле отклоняется. `usage read` возвращает токены и расходы каждой модальности, нераспределённые токены и число оценочных вызовов; права и проверки бюджета общие с админкой.

After login use `yarn cli models status` or `yarn cli models status <profile-id> --json`. Each result includes enabled, ok and a readable message. Exit code 1 means at least one enabled checked profile is unavailable. Disabled optional cloud profiles can report missing credentials without failing the status command. The same checks run in the admin UI; they inspect connectivity and installed models without requesting a generated answer.

Общая диагностика (`diagnostics`), изменение AI-подключений (`models.save/delete`) и управление компаниями (`tenants.create/update`) требуют права владельца платформы. CLI использует те же серверные проверки, что и админка.

## API-ключи владельца

`yarn cli secrets list` возвращает только метаданные. `yarn cli secrets save` принимает JSON через stdin: id, label, provider, enabled, revision и value. Для нового ключа revision=0 и value обязателен; при изменении текущая revision обязательна, отсутствие value сохраняет значение. Не передавайте ключ в аргументах команды или URL. Для автоматизации подавайте JSON из менеджера секретов через stdin; не сохраняйте значение в истории shell или файлах проекта.

`yarn cli secrets delete` принимает id/revision через stdin и требует отсутствия ссылок во всех компаниях. `yarn cli secrets audit` показывает журнал без значений. Все команды требуют права владельца платформы, совпадают с правилами админки и применяются без перезапуска сервера. Полный контракт — в [API](API.md).

## Исправление обработки до публикации

После `yarn cli review DOCUMENT_UUID` вызовите `yarn cli api documents.correct correction.json`. JSON содержит id, актуальную revision документа, version, номер page и исправленный text. Секретов в этом файле нет. После правки повторно прочитайте документ и подтвердите публикацию командой publish. Оригинал сохраняется; опубликованную версию править нельзя.

Google-расшифровка использует обычный `models save`: provider=google, role=transcription, input=[text,audio], secretRef активного Google-ключа, модель Gemini с аудиовходом и актуальные ставки. Затем `settings save` выбирает её id в transcriptionProfile с текущей revision настроек. Команды используют те же бюджет, права и проверки, что UI; они не переключают модель автоматически при ошибке Whisper.

При `indexes build` недостающие описания/расшифровки готовятся автоматически выбранными в настройках компании моделями обработки. Готовый текст повторно не генерируется для другой embedding-модели. Перед `indexes activate` проверьте текст через `review` и результаты поиска; сбой подготовки не переключает текущий индекс.
