import type { Job } from '../../shared/api/contracts.generated';
export const statuses: Record<Job['status'], string> = {
  retrying: 'Ожидание повторной попытки',
  queued: 'В очереди',
  extracting: 'Подготовка материала',
  ocr: 'Распознавание страниц',
  indexing: 'Индексация',
  searching: 'Поиск источников',
  generating: 'Генерация',
  complete: 'Завершено',
  no_info: 'Недостаточно информации',
  clarification: 'Требуется уточнение',
  cancelled: 'Отменено',
  interrupted: 'Прервано',
  failed: 'Техническая ошибка',
};
