import type { DataContext } from '../../application/data-context.js';
/** Limits apply to UTF-8 bytes as well as count, regardless of document or response size. */
export class CacheStore {
  constructor(private readonly data: DataContext) {}
  put(key: string, value: unknown) {
    this.data.catalog
      .prepare('INSERT OR REPLACE INTO cache(key,created,body) VALUES (?,?,?)')
      .run(key, Date.now(), JSON.stringify(value));
    this.data.catalog
      .prepare(
        'DELETE FROM cache WHERE key IN (SELECT key FROM (SELECT key,row_number() OVER(ORDER BY created DESC,rowid DESC) AS position,sum(bytes) OVER(ORDER BY created DESC,rowid DESC) AS total FROM cache) WHERE position>1000 OR total>?)',
      )
      .run(64 * 1024 * 1024);
  }
}
