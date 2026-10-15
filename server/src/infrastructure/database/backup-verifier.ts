import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { requireValue } from '../../shared/errors.js';
import { decodeVector, dot } from '../indexing/vector-codec.js';
import { fileHash } from '../files/file-hash.js';
import { assertCurrentSchema } from './schema.js';
import { originalBlocks, originalBlockSize } from './original-store.js';
/** The same read-only validation is used by admin restore and exclusive local restore. */
export async function verifyBackupFile(path: string) {
  requireValue(
    existsSync(path) && existsSync(path + '.sha256'),
    'NOT_FOUND',
    'Копия или контрольная сумма не найдены.',
    404,
  );
  requireValue(
    (await fileHash(path)) === readFileSync(path + '.sha256', 'utf8').trim(),
    'BACKUP_CORRUPT',
    'Контрольная сумма не совпадает.',
  );
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assertCurrentSchema(db);
    requireValue(
      db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok',
      'BACKUP_CORRUPT',
      'SQLite повреждена.',
    );
    const invalid = [
      "SELECT 1 FROM source_fragments s LEFT JOIN entities v ON v.kind='version' AND v.id=s.version AND v.document=s.document WHERE v.id IS NULL LIMIT 1",
      'SELECT 1 FROM source_usage u WHERE NOT EXISTS(SELECT 1 FROM source_fragments s WHERE s.id=u.chunk) AND NOT EXISTS(SELECT 1 FROM chunks c WHERE c.id=u.chunk) LIMIT 1',
      "SELECT 1 FROM entities v LEFT JOIN entities d ON d.kind='document' AND d.id=v.document WHERE v.kind='version' AND d.id IS NULL LIMIT 1",
      "SELECT 1 FROM originals o LEFT JOIN entities v ON v.kind='version' AND v.id=o.version WHERE v.id IS NULL LIMIT 1",
      'SELECT 1 FROM original_blocks b LEFT JOIN originals o ON o.version=b.version WHERE o.version IS NULL LIMIT 1',
      "SELECT 1 FROM entities d LEFT JOIN entities v ON v.kind='version' AND v.id=d.active_version AND v.document=d.id WHERE d.kind='document' AND d.active_version!='' AND v.id IS NULL LIMIT 1",
      "SELECT 1 FROM chunks c LEFT JOIN entities v ON v.kind='version' AND v.id=c.version AND v.document=c.document WHERE v.id IS NULL LIMIT 1",
      'SELECT 1 FROM chunks c LEFT JOIN fulltext f ON f.id=c.id WHERE f.id IS NULL OR f.body!=c.body LIMIT 1',
      'SELECT 1 FROM fulltext f LEFT JOIN chunks c ON c.id=f.id WHERE c.id IS NULL LIMIT 1',
      'SELECT 1 FROM fulltext GROUP BY id HAVING count(*)!=1 LIMIT 1',
      "SELECT 1 FROM entities r LEFT JOIN entities j ON j.kind='job' AND j.id=json_extract(r.body,'$.job') WHERE r.kind='evaluation_result' AND (j.id IS NULL OR j.job_kind!='evaluation') LIMIT 1",
    ];
    for (const sql of invalid)
      requireValue(
        !db.prepare(sql).get(),
        'BACKUP_CORRUPT',
        'Нарушены связи документов, фрагментов или результатов.',
      );
    requireValue(
      !db.prepare('PRAGMA foreign_key_check').get(),
      'BACKUP_CORRUPT',
      'Нарушены ссылки на сохранённые записи.',
    );
    let originals = 0,
      vectors = 0,
      iterations = 0;
    for (const version of db
      .prepare(
        "SELECT id,checksum,json_extract(body,'$.pages') AS pages FROM entities WHERE kind='version'",
      )
      .iterate()) {
      const pages = new Set(
        (JSON.parse(String(version.pages)) as { number: number }[]).map((page) => page.number),
      );
      for (const row of db
        .prepare(
          'SELECT DISTINCT page FROM chunks WHERE version=? UNION SELECT DISTINCT page FROM source_fragments WHERE version=?',
        )
        .iterate(String(version.id), String(version.id)))
        requireValue(
          pages.has(Number(row.page)),
          'BACKUP_CORRUPT',
          'Фрагмент ссылается на отсутствующую страницу.',
        );
      const length = Number(
        db.prepare('SELECT length AS size FROM originals WHERE version=?').get(String(version.id))
          ?.size ?? 0,
      );
      requireValue(length > 0, 'BACKUP_CORRUPT', 'Оригинал отсутствует.');
      const digest = createHash('sha256');
      let offset = 0;
      for (const block of originalBlocks(db, String(version.id))) {
        requireValue(
          block.part * originalBlockSize === offset &&
            block.bytes.length === Math.min(originalBlockSize, length - offset),
          'BACKUP_CORRUPT',
          'Нарушена последовательность блоков оригинала.',
        );
        digest.update(block.bytes);
        offset += block.bytes.length;
        if (++iterations % 128 === 0) await yieldToIO();
      }
      requireValue(offset === length, 'BACKUP_CORRUPT', 'Оригинал извлечён не полностью.');
      requireValue(
        digest.digest('hex') === version.checksum,
        'BACKUP_CORRUPT',
        'Контрольная сумма оригинала не совпадает.',
      );
      originals++;
      await yieldToIO();
    }
    const dimensions = new Map<string, number>();
    for (const row of db.prepare('SELECT version,vector FROM chunks').iterate()) {
      const vector = decodeVector(row.vector as Uint8Array),
        version = String(row.version);
      requireValue(
        Math.abs(dot(vector, vector) - 1) < 0.001 &&
          (!dimensions.has(version) || dimensions.get(version) === vector.length),
        'BACKUP_CORRUPT',
        'Повреждён векторный индекс.',
      );
      dimensions.set(version, vector.length);
      if (++vectors % 2048 === 0) await yieldToIO();
    }
    return {
      integrity: 'ok',
      originals,
      vectors,
      entities: db
        .prepare('SELECT kind,count(*) AS count FROM entities GROUP BY kind')
        .all()
        .map((row) => ({ kind: String(row.kind), count: Number(row.count) })),
    };
  } finally {
    db.close();
  }
}
