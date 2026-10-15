import { requireValue } from './errors.js';
import type { Input } from './input.js';
import { number } from './input.js';
export function pagination(input: Input) {
  const page = number(input, 'page', 1),
    pageSize = number(input, 'pageSize', 25);
  requireValue(
    Number.isInteger(page) &&
      page > 0 &&
      page <= 100_000 &&
      Number.isInteger(pageSize) &&
      pageSize > 0 &&
      pageSize <= 100,
    'INVALID_INPUT',
    'Неверная страница списка.',
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}
