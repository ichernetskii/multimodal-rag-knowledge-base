import { extname } from 'node:path';
import type { SearchScope } from '../domain/entities.js';
import { requireValue } from './errors.js';
export type Input = Record<string, unknown>;
export const string = (p: Input, k: string, fallback = '', maxLength = 100_000) => {
  const v = p[k] ?? fallback;
  requireValue(
    typeof v === 'string' && v.length <= maxLength,
    'INVALID_INPUT',
    `Некорректное поле ${k}.`,
  );
  return v;
};
export const number = (p: Input, k: string, fallback = 0) => {
  const v = p[k] ?? fallback;
  requireValue(
    typeof v === 'number' && Number.isFinite(v),
    'INVALID_INPUT',
    `Некорректное поле ${k}.`,
  );
  return v;
};
export const strings = (p: Input, k: string) => {
  const v = p[k] ?? [];
  requireValue(
    Array.isArray(v) && v.length <= 1000 && v.every((x) => typeof x === 'string'),
    'INVALID_INPUT',
    `Некорректное поле ${k}.`,
  );
  return v;
};
export const object = (p: Input, k: string) => {
  const v = p[k] ?? {};
  requireValue(
    v && typeof v === 'object' && !Array.isArray(v),
    'INVALID_INPUT',
    `Некорректное поле ${k}.`,
  );
  return v as Input;
};
export function revision(p: Input, existing: { revision: number }) {
  requireValue(
    number(p, 'revision') === existing.revision,
    'REVISION_CONFLICT',
    'Запись изменена другим пользователем. Обновите данные.',
    409,
  );
}
export function scope(p: Input): SearchScope {
  requireValue(
    Object.keys(p).every((key) => key === 'collection' || key === 'conversation'),
    'INVALID_INPUT',
    'Область поиска содержит неподдерживаемые параметры.',
  );
  const out: SearchScope = {};
  for (const key of ['collection', 'conversation'] as const)
    if (p[key] !== undefined) out[key] = string(p, key);
  return out;
}
export const localized = (q: string, ru: string, en: string) => (/[а-яё]/iu.test(q) ? ru : en);
export const supported = (name: string) =>
  ['.md', '.markdown', '.txt', '.pdf'].includes(extname(name).toLowerCase());
export function containsCode(text: string, code: string) {
  const continues = (at: number, direction: number) => {
    const char = text[at] ?? ' ',
      next = text[at + direction] ?? ' ';
    return (
      /[\p{L}\p{N}_+#]/u.test(char) ||
      (/[./-]/u.test(char) && /[\p{L}\p{N}_+#]/u.test(next)) ||
      (direction === 1 && char === ':' && /[\p{L}\p{N}]/u.test(next))
    );
  };
  for (let at = text.indexOf(code); at >= 0; at = text.indexOf(code, at + 1))
    if (!continues(at - 1, -1) && !continues(at + code.length, 1)) return true;
  return false;
}
