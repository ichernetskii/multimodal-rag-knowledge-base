import type { Job } from '../../shared/api/contracts.generated';
export const statuses: Record<Job['status'], string> = {
  retrying: 'Ожидание повторной попытки',
  queued: 'В очереди',
  extracting: 'Извлечение текста',
  ocr: 'Распознавание страниц',
  indexing: 'Индексация',
  searching: 'Поиск источников',
  generating: 'Генерация',
  complete: 'Завершено',
  no_info: 'Недостаточно информации',
  clarification: 'Требуется уточнение',
  cancelled: 'Отменённый ответ',
  interrupted: 'Незавершённый ответ',
  failed: 'Техническая ошибка',
};
