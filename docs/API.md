# Текущий API

Клиент и CLI вызывают один `Application` через HTTP. Контракт находится в [server/src/contracts/public.ts](../server/src/contracts/public.ts), клиентская копия генерируется командой `yarn contracts:generate`. Совместимость с прежними контрактами отсутствует. Рабочая база — `RAG_DATA_DIR/catalog.sqlite`.

## Авторизация

`POST /api/login`: `{login,password}`. Ответ содержит текущего пользователя; сервер устанавливает cookie `rag_session` с HttpOnly, SameSite=Strict и Secure для HTTPS. Для CLI/автоматизации запрос с `cli:true` также возвращает bearer token. Браузер приложения использует cookie; обычные действия API принимают и bearer. `POST /api/logout` отзывает сессию. Browser localStorage не содержит токенов. Пароль должен содержать минимум 12 символов; смена пароля отзывает сессии. Cookie-запросы записи требуют точного same-origin Origin; для reverse proxy задайте `RAG_PUBLIC_ORIGIN`, при необходимости `TRUST_PROXY=1`.

`POST /api/actions/<action>` принимает JSON-объект. Неизвестная команда — `ACTION_NOT_FOUND`, неизвестное поле команды — `INVALID_INPUT`. CLI эквивалентен: `yarn cli api <action> input.json`, без файла JSON читается из stdin. `revision` — прочитанная версия изменяемой записи; конфликт возвращает 409 без перезаписи. Все action-ответы при успехе имеют HTTP 200 и сразу содержат результат, без общей обёртки data. Для фоновой работы это принятое Job или объект с job, а не завершённый ответ модели. Время created/updated/expires — Unix milliseconds, страницы PDF нумеруются с 1. Браузер и API должны иметь общий origin через proxy; отдельный CORS API не предоставляется.

| Команда                                                      | Вход                                                                             | Доступ / результат                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| setup.status / setup.create                                  | {} / login,password,settings?                                                    | Первый администратор создаётся однократно через локальное подключение                                            |
| me                                                           | {}                                                                               | `{user, permissionsVersion, contentVersion}`; актуальные права и версии данных                                   |
| sessions.list / sessions.revoke                              | {} / id                                                                          | Свои сессии                                                                                                      |
| password.change                                              | oldPassword,password                                                             | Свой пароль; сессии отзываются                                                                                   |
| users.list / users.create                                    | page?,pageSize?,query?,role?,state?,ids? / login,password,role?,groups?,blocked? | Администратор; ListPage / созданный пользователь без хеша пароля                                                 |
| users.update / users.revoke                                  | id,revision,role?,blocked?,groups?,password? / id                                | Администратор; нельзя отключить последнего администратора                                                        |
| groups.list / groups.save                                    | {} / name,id?,revision?                                                          | Администратор                                                                                                    |
| collections.list                                             | {}                                                                               | Доступные базы                                                                                                   |
| collections.rename / collections.save                        | id,revision,name / name,grants,id?,revision?                                     | Название: редактор базы; права: администратор; grants=[{subject,access}]; пользователь: UUID, группа: group:UUID |
| documents.limits                                             | {}                                                                               | Лимиты загрузки                                                                                                  |
| documents.list                                               | query?,sort?,state?,scope?,page?,pageSize?                                       | Разрешённые документы; sort=name/updated/state; ListPage                                                         |
| documents.preview                                            | collection или conversation,files                                                | files=[{name,bytes,hash}]; new/duplicate/update/unsupported/limit                                                |
| documents.upload                                             | name,base64,collection или conversation,document?,revision?                      | Новая версия и задание обработки                                                                                 |
| documents.read                                               | id,version?                                                                      | Документ, версия с извлечёнными страницами, сводка версий                                                        |
| documents.publish                                            | id,revision,version,acknowledge?,activate?                                       | Редактор базы/владелец вложения; проверка OCR и переиндексация                                                   |
| documents.update / documents.delete                          | id,revision,name?,state? / id,revision                                           | Редактирование / окончательное удаление                                                                          |
| documents.bulk                                               | ids,revisions,operation                                                          | Все права/версии проверяются до изменения; archive/exclude/delete                                                |
| documents.compare / documents.restore                        | id,left,right / id,revision,version                                              | Сравнение страниц / выбор готовой версии                                                                         |
| sources.read                                                 | chunk                                                                            | Конкретная версия, страница и сохранённый фрагмент с контекстом                                                  |
| search                                                       | question,scope?                                                                  | Гибридный поиск без генерации                                                                                    |
| conversations.list / conversations.create                    | query?,page?,pageSize? / title?                                                  | Только владелец                                                                                                  |
| conversations.read                                           | id,before?,pageSize?                                                             | Последние сообщения выбранной ветки, jobs, history, variantCounts                                                |
| conversations.variants                                       | id,parent,page?,pageSize?                                                        | ListPage вариантов вопроса; текст вопроса до 200 символов                                                        |
| conversations.save / conversations.delete                    | id,revision,title?,draft?,selected? / id,revision                                | Только владелец                                                                                                  |
| answers.create                                               | conversation,revision,question,scope?,replaces?                                  | Новая версия вопроса и задание; прежняя версия сохраняется                                                       |
| jobs.read / jobs.cancel                                      | id                                                                               | Владелец/разрешённый редактор; частный чат доступен владельцу                                                    |
| feedback.create                                              | turn,rating,reason,detail?                                                       | Оценка собственного ответа                                                                                       |
| quality.list / quality.save / quality.run                    | page?,pageSize? / question,documents,facts,refuse?,scope?,id?,revision? / {}     | Администратор; списки, контрольный вопрос и фоновое задание                                                      |
| quality.delete / quality.results                             | id,revision / job,page?,pageSize?                                                | Удаление контрольного вопроса / ListPage отдельных результатов                                                   |
| settings.read / settings.save                                | {} / revision,settings                                                           | Администратор                                                                                                    |
| sync.list / sync.save                                        | {} / path,collection,policy,intervalMinutes,id?,revision?                        | Администратор; policy=keep/exclude/delete                                                                        |
| sync.preview / sync.run / sync.delete                        | id / id / id,revision                                                            | Предварительный просмотр / ручной запуск / удалить настройку                                                     |
| backup.list / backup.create / backup.verify / backup.restore | {} / {} / id / id                                                                | Администратор; целостная текущая схема, сессии отзываются                                                        |
| diagnostics / operations / cleanup                           | {}                                                                               | Администратор; модели/индекс/диск, показатели, очистка                                                           |

`ListPage<T>` имеет `{items,total,page,pageSize}`. По умолчанию страница содержит 25 записей, максимум 100. `conversations.read` по умолчанию возвращает 40 сообщений выбранной цепочки. `history={before,hasMore}` задаёт курсор подгрузки назад; `variantCounts` считает варианты по parent. Смена selected сохраняется на сервере. Полный экспорт всех сохранённых веток: **GET `/api/conversations/<id>/export`**, JSON-attachment `{conversation,turns,exported}`. Он идёт потоком из согласованного SQLite snapshot с актуальной проверкой ACL перед каждым сообщением; текст недоступных результатов скрывается так же, как в истории. POST-команды экспорта нет.

`sources.read {chunk}` возвращает `{document,version,page,source}`: конкретную страницу и фрагмент с контекстом. Он не возвращает все страницы документа. Сохранённая цитата доступна после повторной индексации той же версии; актуальные права проверяются и для неизменяемого снимка фрагмента.

`quality.run` возвращает Job; его result содержит `{total,processed,passed,failed}`. Отдельные результаты читаются через quality.results и содержат вопрос, ожидаемые документы/факты, пять отдельных критериев, фактические источники/версии, ответ, настройки обработки и ошибку при её наличии. Изменение или удаление контрольного вопроса требует актуальную revision. Контрольный набор предназначен для общих баз знаний: scope.conversation и личные вложения отклоняются с QUALITY_SCOPE. Отчёты скрывают недоступные ответы, вопросы, факты и источники.

`scope` содержит только `collection` и `conversation`. Если он отсутствует в answers.create, область наследуется от выбранной версии разговора. Переданный scope полностью задаёт новый выбор; `{}` означает все доступные базы. Поиск проверяет права, опубликованное состояние и активную версию. Личные вложения участвуют только в своём диалоге и могут дополнять выбранную общую базу. Scope входит в ключи кеша; права, индекс и настройки инвалидируют кеш. Произвольные атрибуты документа не принимаются.

Документ имеет устойчивый UUID, независимо от имени и пути. Повторное содержимое в одной области доступа не создаёт дубликат. Совпадение имени в preview обозначает предполагаемое обновление; замена требует явных document/revision. Версия содержит имя оригинала, SHA-256, время создания, страницы/разделы, предупреждения и подпись индекса.

Оригинал: `GET /api/documents/<id>?version=<version-id>&download=1`. Поддерживается также HEAD и один Range `bytes=start-end` / `bytes=-suffix`: 206 с Content-Range; недопустимый диапазон — 416. Без download открывается inline; PDF использует `#page=N`. Оригинал стримится порциями до 64 КиБ, с проверкой сессии/прав перед каждой порцией. Общие необработанные версии доступны редактору базы/администратору. `activate:false` при переиндексации сохраняет текущую активную версию.

Feedback reason: `wrong_source`, `outdated`, `no_answer`, `irrelevant_answer`, `other`; rating: -1/1. Оценки не изменяют документы.

## Примеры запросов

Создайте отдельную тестовую установку для изменяющих запросов. В примерах замените значения в угловых скобках реальными ID. Неизвестные поля в actions отклоняются.

```http
POST /api/actions/search
Authorization: Bearer <token>
Content-Type: application/json

{"question":"E-42","scope":{"collection":"<collection-id>"}}
```

Результат — массив Source с `chunk`, `document`, `version`, `page`, `section`, `name`, `text` и локальным номером `id` для цитирования. Оценки вероятности правильности в результате нет. Пустой массив означает отсутствие доступных подходящих источников; генерация не запускается.

Для ответа сначала вызовите `conversations.create {}` и используйте возвращённые id/revision:

```http
POST /api/actions/answers.create
Authorization: Bearer <token>
Content-Type: application/json

{"conversation":"<conversation-id>","revision":1,"question":"Что означает E-42?","scope":{"collection":"<collection-id>"}}
```

Ответ содержит `{conversation,turn,job}`. Сохраните job.id, подключитесь к SSE либо вызывайте `jobs.read {id}`. После завершения перечитайте `conversations.read {id}`. Чтобы отредактировать вопрос или повторить ответ, передайте replaces с ID прежнего Turn и актуальную revision диалога. Для продолжения выбранной цепочки сначала сохраните selected через conversations.save.

Изменение лимита установки:

```http
POST /api/actions/settings.save
Authorization: Bearer <admin-token>
Content-Type: application/json

{"revision":1,"settings":{"topK":5}}
```

Revision берётся из settings.read; ответ содержит полные актуальные Settings. Для cookie-запросов записи браузер должен передать правильный Origin. Подробные примеры stdin/файлов — в [CLI.md](CLI.md).

## SSE и состояния

`GET /api/events/<job-id>` использует cookie/bearer; поддерживает Last-Event-ID или `?after=N`. Событие `snapshot` содержит `{job,turn?}` с монотонным id. Это актуальное состояние, поэтому удаление старых событий не мешает восстановлению страницы. Проверка обновлений идёт раз в секунду; при отсутствии изменений отправляется комментарий `: heartbeat`. Поток не является журналом всех токенов и не гарантирует воспроизведение каждого промежуточного состояния. После терминального snapshot клиент закрывает соединение; сервер сам не завершает успешный поток. Сессия и доступ перепроверяются при каждом poll; `error` содержит `{code,message,diagnostic}` и закрывает поток.

Состояния: `queued`, `extracting`, `ocr`, `indexing`, `searching`, `generating`, `complete`, `no_info`, `clarification`, `cancelled`, `interrupted`, `failed`. Сервер не выдаёт выдуманный процент или ETA. При переподключении клиент читает сохранённый диалог и подключается к незавершённым заданиям. Максимум 8 SSE на пользователя; клиент использует пул из 4, из них не больше 3 занимают документы, чтобы сохранить ресурс чата. Медленный клиент отключается при превышении ограничений буфера/времени блокировки. Proxy: буферизацию выключить, read timeout держать выше heartbeat; примеры в `client/deploy/`.

Пример кадра (JSON в data передаётся одной строкой; поля Job/Turn определены контрактом):

```text
id: <sequence>
event: snapshot
data: {"job":{...},"turn":{...}}

```

При ошибке уже открытого потока приходит `event: error` с `data: {"code":"...","message":"...","diagnostic":"..."}` и без HTTP-обёртки error. Отказ до открытия потока — обычный JSON-ответ HTTP. При повторном подключении используйте сохранённый event id; при необходимости перечитайте задание. Терминальные состояния: complete, no_info, clarification, cancelled, interrupted, failed. Clarification завершает текущее задание; уточнение отправляется новым вопросом.

## Health и ошибки

`GET /health/live` проверяет процесс; `/health/ready` — приём заданий, очереди, диск и обслуживание; `/health/dependencies` требует администратора и проверяет модели. История и документы доступны независимо от генерации.

Ошибка HTTP: `{error:{code,message,diagnostic}}`. У фонового Job ошибка хранится в `error` и `diagnostic`, сообщение — в `result.message`, если оно есть. HTTP 200 при постановке задания не исключает его последующий failed. Diagnostic — уникальный идентификатор для технического разбора (UUID приложения или request ID nginx); полные документы/вопросы/ответы в технический журнал не записываются.

| Коды                                                                                                                                                     | HTTP / смысл                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| INVALID_INPUT, INVALID_JSON, UNSUPPORTED_FORMAT, QUALITY_SCOPE, FILE_LIMIT, PAGE_LIMIT, EXTRACTED_TEXT_LIMIT, CHUNK_LIMIT, CONTENT_LOSS, REVIEW_REQUIRED | 400; исправить запрос/файл или проверить извлечение           |
| UNAUTHENTICATED, AUTH_FAILED                                                                                                                             | 401; войти                                                    |
| FORBIDDEN, ACCESS_REVOKED, ORIGIN_REJECTED, CSRF_REJECTED, SETUP_LOCAL_ONLY                                                                              | 403; доступ/Origin                                            |
| NOT_FOUND, ACTION_NOT_FOUND                                                                                                                              | 404                                                           |
| REVISION_CONFLICT, DOCUMENT_BUSY, SYNC_BUSY, SEARCH_CHANGED, WRITER_RUNNING, SCHEMA_INCOMPATIBLE, INDEX_INCOMPATIBLE                                     | 409; конфликт состояния/формата                               |
| SSE_LIMIT, QUEUE_FULL, RATE_LIMIT, UPLOAD_BUSY, DOWNLOAD_BUSY, QUERY_BUSY                                                                                | 429; лимит                                                    |
| REQUEST_LIMIT                                                                                                                                            | 413; тело запроса больше допустимого                          |
| INVALID_RANGE                                                                                                                                            | 416; недоступный диапазон оригинала                           |
| DISK_FULL                                                                                                                                                | 507; недостаточно места                                       |
| MAINTENANCE, SETUP_REQUIRED, INTAKE_PAUSED                                                                                                               | 503; сервер не готов к операции                               |
| GENERATION_UNAVAILABLE, GENERATION_TIMEOUT, BACKUP_CORRUPT, INTERNAL                                                                                     | Стабильный code и diagnostic; подробность зависит от операции |

Таблица перечисляет основные ошибки, а не исчерпывающий реестр. Код выбирается по месту отказа; SSE_LIMIT при превышении числа соединений даёт 429, а при слишком большом snapshot передаётся уже внутри SSE. Сообщение может уточняться, код и diagnostic используются для обработки/диагностики.

Локальное recovery: `POST /api/recover` принимает login/password с локальным bearer recovery key. CLI выполняет это автоматически для работающего сервера; при остановленном сервере открывает каталог с эксклюзивным writer lock. Обычные команды не обходят сервер.

## Транспорт и ограничения

API использует JSON UTF-8; автоматизация может использовать bearer, браузер приложения использует HttpOnly cookie. Recovery принимает отдельный локальный ключ, а не обычную пользовательскую сессию. Upload принимает base64 в JSON, ограниченный maxBytes и двумя одновременно читаемыми upload-запросами; browser отправляет файлы последовательно. Стандартное тело команды ограничено 100000 байт, upload — текущим лимитом файла с запасом на base64. API не возвращает HTML вместо ошибок. Клиентский gateway возвращает собственный стабильный SERVER_UNAVAILABLE/diagnostic при недоступном upstream.

Полный список env и настроек с диапазонами — в [CONFIGURATION.md](CONFIGURATION.md). Настройки `maxTextCharacters` (по умолчанию 8 млн, максимум 32 млн) и `maxChunks` (по умолчанию 20000, максимум 50000) ограничивают распаковку документа и индекс. Превышение не публикует частично обработанный документ. OCR-страницы с предупреждениями требуют acknowledge; пустая страница или ошибка OCR блокирует публикацию независимо от acknowledge.

Скачивание/экспорт ограничены временем и backpressure: CLIENT_TIMEOUT/DOWNLOAD_TIMEOUT, отмена обслуживания — MAINTENANCE. При ошибке после начала потока сервер закрывает соединение; CLI не публикует неполный временный файл. Во время восстановления новые операции запрещены, существующие скачивания отменяются. Успешный backup.restore возвращает отчёт 200 и отзывает все сессии; для дальнейшей работы требуется войти снова.

Полные типы входов и результатов, обязательность полей и имена команд описаны в `ActionInputs`, `ActionResults` и `actionFields` текущего contracts/public.ts. Client typecheck и архитектурный тест проверяют согласованность контракта с вызовами и регистрацией сервисов.
