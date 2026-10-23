export const text = (f: FormData, key: string) =>
  typeof f.get(key) === 'string' ? (f.get(key) as string) : '';
export const values = (f: FormData, key: string) =>
  f.getAll(key).filter((value): value is string => typeof value === 'string');
export function option<T extends string>(f: FormData, key: string, allowed: readonly T[]): T {
  const value = text(f, key);
  if (!allowed.includes(value as T)) throw new Error('Invalid field value: ' + key);
  return value as T;
}
