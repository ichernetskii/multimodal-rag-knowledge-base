import { randomUUID } from 'node:crypto';
import type { Database } from '../infrastructure/database/postgres.js';
import { AppError } from '../shared/errors.js';
export class Resources {
  constructor(private readonly db: Database) {}
  async acquire(scopes: { key: string; limit: number }[], signal: AbortSignal, waitMs = 1500) {
    const id = randomUUID(),
      until = Date.now() + waitMs;
    while (true) {
      signal.throwIfAborted();
      const acquired = await this.db.transaction(async () => {
        for (const scope of [...scopes].sort((a, b) => a.key.localeCompare(b.key)))
          await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [scope.key]);
        await this.db.query('DELETE FROM resource_leases WHERE expires<$1', [Date.now()]);
        for (const scope of scopes) {
          const rows = await this.db.query<{ count: string }>(
            'SELECT count(*) FROM resource_leases WHERE scope=$1',
            [scope.key],
          );
          if (Number(rows[0]?.count) >= scope.limit) return false;
        }
        for (const scope of scopes)
          await this.db.query('INSERT INTO resource_leases VALUES($1,$2,$3)', [
            scope.key,
            id,
            Date.now() + 30000,
          ]);
        return true;
      });
      if (acquired) break;
      if (Date.now() > until)
        throw new AppError('CAPACITY_BUSY', 'Resources are busy; the job will retry.', 429);
      await new Promise((r) => setTimeout(r, 100));
    }
    const timer = setInterval(() => {
      void this.db
        .query('UPDATE resource_leases SET expires=$1 WHERE id=$2', [Date.now() + 30000, id])
        .catch(() => {});
    }, 5000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await this.db.query('DELETE FROM resource_leases WHERE id=$1', [id]);
    };
  }
  async rate(scope: string, requests: number, tokens: number, maxTokens: number) {
    const window_start = Math.floor(Date.now() / 60000);
    await this.db.transaction(async () => {
      await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        scope + ':' + window_start,
      ]);
      const rows = await this.db.query<{ requests: number; tokens: string }>(
        'SELECT requests,tokens FROM rate_windows WHERE scope=$1 AND window_start=$2',
        [scope, window_start],
      );
      if ((rows[0]?.requests ?? 0) >= requests || Number(rows[0]?.tokens ?? 0) + tokens > maxTokens)
        throw new AppError(
          'PROVIDER_RATE_LIMIT',
          'Provider rate budget exhausted; retry later.',
          429,
        );
      await this.db.query(
        'INSERT INTO rate_windows VALUES($1,$2,1,$3) ON CONFLICT(scope,window_start) DO UPDATE SET requests=rate_windows.requests+1,tokens=rate_windows.tokens+excluded.tokens',
        [scope, window_start, tokens],
      );
    });
  }
}
