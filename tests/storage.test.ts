import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteVectorStore } from '../src/storage/sqlite-store.js';
import type { IndexedChunk } from '../src/core/contracts.js';
import { chunk, storedDocument, vector } from './helpers.js';

const options = { dimensions: 3, signature: 'test-model' };
async function database(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rag-storage-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'rag.sqlite');
}

void test('SQLite stores text and vectors; cosine scores support a threshold', async (context) => {
  const path = await database(context);
  let store = new SqliteVectorStore(path, options);
  try {
    await store.replaceDocument(storedDocument(), [chunk('leave'), chunk('laptop', 1, 1)]);
  } finally {
    store.close();
  }
  store = new SqliteVectorStore(path, { ...options, create: false });
  try {
    const hits = await store.search(vector(), { limit: 2 });
    assert.equal(hits[0]?.chunk.body, 'leave');
    assert.ok(Math.abs((hits[0]?.score ?? 0) - 1) < 0.000001);
    assert.equal(hits[1]?.score, 0);
    assert.equal((await store.search(vector(), { limit: 2, minScore: 0.5 })).length, 1);
    assert.equal((await store.stats()).vectors, 2);
  } finally {
    store.close();
  }
});

void test('Reingestion creates no duplicates and preserves other documents', async (context) => {
  const store = new SqliteVectorStore(await database(context), options);
  try {
    await store.replaceDocument(storedDocument('a'), [chunk('old'), chunk('remove', 1)]);
    await store.replaceDocument(storedDocument('b'), [chunk('another document', 0, 1)]);
    await store.replaceDocument(storedDocument('a'), [chunk('old'), chunk('remove', 1)]);
    assert.equal((await store.stats()).chunks, 3);
    await store.replaceDocument(storedDocument('a', 'v2'), [chunk('new')]);
    assert.equal((await store.stats()).chunks, 2);
    assert.equal((await store.stats()).vectors, 2);
    assert.equal(store.listChunks('a')[0]?.body, 'new');
    assert.equal(store.listChunks('a')[0]?.generation, 'v2');
    assert.equal(store.listChunks('b')[0]?.body, 'another document');
  } finally {
    store.close();
  }
});

void test('SQL failure during replacement rolls back text, vectors, and the document version', async (context) => {
  const store = new SqliteVectorStore(await database(context), options);
  try {
    await store.replaceDocument(storedDocument(), [chunk('original')]);
    const invalid = { ...chunk('invalid', 1, 1), body: null } as unknown as IndexedChunk;
    await assert.rejects(
      store.replaceDocument(storedDocument('a', 'v2'), [chunk('new'), invalid]),
      /NOT NULL/u,
    );
    assert.equal(store.listChunks('a')[0]?.body, 'original');
    assert.equal(store.listChunks('a')[0]?.generation, 'v1');
    assert.equal((await store.stats()).chunks, 1);
    assert.equal((await store.search(vector(), { limit: 1 }))[0]?.chunk.body, 'original');
  } finally {
    store.close();
  }
});

void test('Invalid vectors, incompatible profiles, and empty replacements are rejected', async (context) => {
  const path = await database(context);
  const store = new SqliteVectorStore(path, options);
  try {
    await assert.rejects(
      store.replaceDocument(storedDocument(), [{ ...chunk(), vector: [1, 0] }]),
      /3 finite/u,
    );
    await assert.rejects(
      store.replaceDocument(storedDocument(), [{ ...chunk(), vector: [0, 0, 0] }]),
      /nonzero/u,
    );
    await assert.rejects(store.replaceDocument(storedDocument(), []), /without chunks/u);
    assert.equal((await store.stats()).documents, 0);
  } finally {
    store.close();
  }
  assert.throws(
    () => new SqliteVectorStore(path, { ...options, signature: 'another' }),
    /different embedding/u,
  );
  assert.throws(
    () => new SqliteVectorStore(path, { ...options, dimensions: 4 }),
    /different embedding/u,
  );
});

void test('An empty index is supported and unrelated SQLite databases are protected', async (context) => {
  const path = await database(context);
  const store = new SqliteVectorStore(path, options);
  try {
    assert.deepEqual(await store.search(vector(), { limit: 1 }), []);
  } finally {
    store.close();
  }
  const foreignPath = join(path, '..', 'foreign.sqlite');
  const foreign = new DatabaseSync(foreignPath);
  foreign.exec("CREATE TABLE important(value TEXT); INSERT INTO important VALUES ('keep');");
  foreign.close();
  assert.throws(() => new SqliteVectorStore(foreignPath, options), /another database/u);
  const untouched = new DatabaseSync(foreignPath);
  try {
    assert.equal(untouched.prepare('SELECT value FROM important').get()?.value, 'keep');
  } finally {
    untouched.close();
  }
});
