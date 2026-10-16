import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
export class SharedCache {
  readonly client;
  private pending = new Map<string, Promise<unknown>>();
  hits = 0;
  misses = 0;
  constructor(url: string) {
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1024,
      socket: { connectTimeout: 1500, reconnectStrategy: () => 2000 },
    });
    this.client.on('error', () => {});
  }
  async start() {
    await Promise.race([
      this.client.connect().catch(() => {}),
      new Promise<void>((r) => setTimeout(r, 1600)),
    ]);
  }
  get healthy() {
    return this.client.isReady;
  }
  async get<T>(key: string): Promise<T | undefined> {
    if (!this.healthy) {
      this.misses++;
      return;
    }
    try {
      const value = await this.client.withCommandOptions({ timeout: 1500 }).get('rag:' + key);
      if (value) {
        this.hits++;
        return JSON.parse(value) as T;
      }
    } catch {
      /* Redis is disposable. */
    }
    this.misses++;
    return;
  }
  async put(key: string, value: unknown, seconds: number) {
    if (!this.healthy || seconds <= 0) return;
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) return;
    try {
      await this.client
        .withCommandOptions({ timeout: 1500 })
        .set('rag:' + key, text, { EX: Math.min(seconds, 604800) });
    } catch {
      /* Cache loss never loses application state. */
    }
  }
  async notify(tenant: string, job: string) {
    if (this.healthy)
      try {
        await this.client.withCommandOptions({ timeout: 1500 }).publish('rag:jobs:' + tenant, job);
      } catch {
        /* Durable state is in PostgreSQL. */
      }
  }
  async singleFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
    const current = this.pending.get(key);
    if (current) return current as Promise<T>;
    const promise = work().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  async distributed<T>(key: string, work: () => Promise<T>): Promise<T> {
    return this.singleFlight(key, async () => {
      const cached = await this.get<T>(key);
      if (cached !== undefined) return cached;
      const token = randomUUID();
      let acquired = false;
      if (this.healthy)
        try {
          acquired =
            (await this.client
              .withCommandOptions({ timeout: 1500 })
              .set('rag:lock:' + key, token, { NX: true, PX: 15000 })) === 'OK';
          if (!acquired) {
            for (let i = 0; i < 10; i++) {
              await new Promise((r) => setTimeout(r, 100));
              const result = await this.get<T>(key);
              if (result !== undefined) return result;
            }
          }
        } catch {
          /* Redis is disposable. */
        }
      try {
        const result = await work();
        await this.put(key, result, 3600);
        return result;
      } finally {
        if (acquired && this.healthy)
          try {
            await this.client
              .withCommandOptions({ timeout: 1500 })
              .eval(
                "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
                { keys: ['rag:lock:' + key], arguments: [token] },
              );
          } catch {
            /* Redis is disposable. */
          }
      }
    });
  }
  async clearTenant(tenant: string) {
    if (!this.healthy) return;
    try {
      for await (const keys of this.client.scanIterator({
        MATCH: 'rag:' + tenant + ':*',
        COUNT: 100,
      }))
        if (keys.length) await this.client.withCommandOptions({ timeout: 1500 }).unlink(keys);
    } catch {
      /* Epoch invalidation still protects authoritative results. */
    }
  }
  async close() {
    if (this.client.isOpen) this.client.destroy();
  }
}
