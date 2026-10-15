import { loadRuntimeConfig } from '../../config/runtime-config.js';
import {
  checkApplication,
  setupApplication,
} from '../../infrastructure/models/embedding-runtime.js';
import { runCliCommand } from './commands.js';
import { AppError, errorResponse } from '../../shared/errors.js';

const help = `Local RAG — автономный сервер, чат, документы и администрирование.

  setup                       Подготовить embedding-модель (интернет)
  check [--embedding-only|--storage-only]  Проверить локальные зависимости
  serve                       API на 3210; интерфейс запускается отдельно на 5173/8080
  login <login>               Войти; пароль через stdin
  logout                      Отозвать текущую сессию
  upload <file> <collection> [document revision]  Загрузить новую версию
  download <document> <output> [version]  Скачать оригинал
  export <conversation> <output.json>  Выгрузить диалог со всеми версиями и источниками
  search <question>           Поиск без генерации
  ask <question>              Сохранённый диалог и ответ
  api <action> [input.json]   Все операции UI через API; JSON через stdin
  diagnose | operations      Диагностика / эксплуатационные показатели
  backup | backups           Создание / список копий
  quality-check              Запуск, ожидание и результаты контрольных вопросов
  cleanup                    Применить сроки хранения
  recover-admin <login>      Локальное восстановление; пароль через stdin
  restore-installation <backup.sqlite> <target-directory>  Офлайн-restore

RAG_DATA_DIR, RAG_URL, RAG_PORT, RAG_HOST; API: docs/API.md.
CLI применяет права работающего сервера. Offline recovery и восстановление
требуют эксклюзивную блокировку каталога.`;
const [command, ...args] = process.argv.slice(2);
try {
  if (!command || command === 'help' || command === '--help') console.log(help);
  else if (command === 'setup') console.log(await setupApplication(loadRuntimeConfig()));
  else if (command === 'check') {
    if (args.length > 1 || args.some((a) => !['--embedding-only', '--storage-only'].includes(a)))
      throw new AppError('INVALID_INPUT', 'check [--embedding-only|--storage-only]');
    console.log(
      await checkApplication(
        loadRuntimeConfig(),
        args[0] === '--embedding-only'
          ? 'embedding'
          : args[0] === '--storage-only'
            ? 'storage'
            : 'all',
      ),
    );
  } else await runCliCommand(command, args);
} catch (error) {
  const result = errorResponse(error);
  console.error(`[${result.error.code}] ${result.error.message} (${result.error.diagnostic})`);
  process.exitCode = 1;
}
