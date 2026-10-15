import type { StatementSync } from 'node:sqlite';
import { requireValue } from '../../shared/errors.js';
export const originalBlockSize = 65536;
interface Database {
  prepare(sql: string): StatementSync;
}
/** Fixed-size rows avoid repeatedly materializing an entire SQLite BLOB for each HTTP range. */
export function storeOriginal(db: Database, version: string, bytes: Uint8Array) {
  db.prepare('INSERT INTO originals VALUES (?,?)').run(version, bytes.byteLength);
  const insert = db.prepare('INSERT INTO original_blocks VALUES (?,?,?)');
  for (let offset = 0; offset < bytes.byteLength; offset += originalBlockSize)
    insert.run(
      version,
      offset / originalBlockSize,
      bytes.subarray(offset, offset + originalBlockSize),
    );
}
export function* originalBlocks(db: Database, version: string) {
  for (const row of db
    .prepare('SELECT part,bytes FROM original_blocks WHERE version=? ORDER BY part')
    .iterate(version))
    yield { part: Number(row.part), bytes: row.bytes as Uint8Array };
}
export function readOriginal(db: Database, version: string) {
  const row = db.prepare('SELECT length FROM originals WHERE version=?').get(version);
  requireValue(row, 'NOT_FOUND', 'Оригинал не найден.', 404);
  const output = Buffer.alloc(Number(row.length));
  let offset = 0;
  for (const block of originalBlocks(db, version)) {
    requireValue(
      block.part * originalBlockSize === offset && offset + block.bytes.byteLength <= output.length,
      'ORIGINAL_CORRUPT',
      'Повреждены блоки оригинала.',
      500,
    );
    output.set(block.bytes, offset);
    offset += block.bytes.byteLength;
  }
  requireValue(
    offset === output.length,
    'ORIGINAL_CORRUPT',
    'Оригинал извлечён не полностью.',
    500,
  );
  return output;
}
export function originalRange(db: Database, version: string, offset: number, length: number) {
  const first = Math.floor(offset / originalBlockSize),
    last = Math.floor((offset + length - 1) / originalBlockSize),
    rows = db
      .prepare(
        'SELECT part,bytes FROM original_blocks WHERE version=? AND part BETWEEN ? AND ? ORDER BY part',
      )
      .all(version, first, last);
  requireValue(
    rows.length === last - first + 1,
    'ORIGINAL_CORRUPT',
    'Повреждены блоки оригинала.',
    500,
  );
  const output = Buffer.alloc(length);
  let written = 0;
  for (const row of rows) {
    const part = Number(row.part),
      bytes = row.bytes as Uint8Array,
      start = Math.max(0, offset - part * originalBlockSize),
      count = Math.min(bytes.byteLength - start, length - written);
    requireValue(count > 0, 'ORIGINAL_CORRUPT', 'Некорректный блок оригинала.', 500);
    output.set(bytes.subarray(start, start + count), written);
    written += count;
  }
  requireValue(written === length, 'ORIGINAL_CORRUPT', 'Оригинал извлечён не полностью.', 500);
  return output;
}
