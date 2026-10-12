import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import type {
  IndexedChunk,
  SearchHit,
  SearchOptions,
  StoredDocument,
  StoreStats,
  Vector,
  VectorStore,
} from '../core/contracts.js';

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid SQLite text record.');
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'bigint')
    throw new Error('Invalid SQLite numeric record.');
  return Number(value);
}
export interface SqliteStoreOptions {
  dimensions: number;
  signature: string;
  create?: boolean;
  readOnly?: boolean;
}

export interface SqliteStoreStats extends StoreStats {
  path: string;
  sqliteVersion: string;
  vectorExtensionVersion: string;
}

export class SqliteVectorStore implements VectorStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(
    path: string,
    private readonly options: SqliteStoreOptions,
  ) {
    this.path = path === ':memory:' ? path : resolve(path);
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1)
      throw new Error('Invalid vector dimensions.');
    if (options.create === false && !existsSync(this.path))
      throw new Error('The database is missing. Run yarn ingest <file> first.');
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path, {
      allowExtension: true,
      readOnly: options.readOnly ?? false,
    });
    try {
      sqliteVec.load(this.db);
      this.db.enableLoadExtension(false);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const version = number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      if (version === 0) {
        if (
          this.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .all().length
        )
          throw new Error('This file contains another database. Set a new SQLITE_PATH.');
        if (options.create === false || options.readOnly)
          throw new Error('This file does not contain a ready RAG index. Run ingest first.');
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE rag_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE documents(doc_id TEXT PRIMARY KEY, source TEXT NOT NULL, source_path TEXT NOT NULL, generation TEXT NOT NULL);
          CREATE TABLE chunks(id INTEGER PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(doc_id), chunk_index INTEGER NOT NULL, body TEXT NOT NULL, embedding_input TEXT NOT NULL, section TEXT NOT NULL, token_count INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, UNIQUE(doc_id, chunk_index));
          CREATE VIRTUAL TABLE chunk_vectors USING vec0(embedding float[${options.dimensions}] distance_metric=cosine);
          PRAGMA user_version=2;`);
        this.db
          .prepare('INSERT INTO rag_meta(key,value) VALUES (?,?)')
          .run('signature', options.signature);
        this.db
          .prepare('INSERT INTO rag_meta(key,value) VALUES (?,?)')
          .run('dimensions', String(options.dimensions));
        this.db.exec('COMMIT');
      } else if (version !== 2)
        throw new Error(
          'Unsupported database version. Set a new SQLITE_PATH and run ingest again.',
        );
      const signature = this.db
        .prepare("SELECT value FROM rag_meta WHERE key='signature'")
        .get()?.value;
      const dimensions = this.db
        .prepare("SELECT value FROM rag_meta WHERE key='dimensions'")
        .get()?.value;
      if (signature !== options.signature || dimensions !== String(options.dimensions))
        throw new Error(
          'The index was created with a different embedding model or tokenizer. Set a new SQLITE_PATH and run ingest again.',
        );
      if (!options.readOnly) this.db.exec('PRAGMA journal_mode=WAL;');
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private vectorBlob(vector: Vector): Uint8Array {
    const values = Float32Array.from(vector);
    if (
      values.length !== this.options.dimensions ||
      !values.every(Number.isFinite) ||
      Math.hypot(...values) === 0
    )
      throw new Error(`Expected a nonzero vector of ${this.options.dimensions} finite numbers.`);
    return new Uint8Array(values.buffer);
  }

  async replaceDocument(document: StoredDocument, chunks: readonly IndexedChunk[]): Promise<void> {
    if (!chunks.length) throw new Error('Cannot index a document without chunks.');
    const vectors = chunks.map((chunk) => this.vectorBlob(chunk.vector));
    const removeVector = this.db.prepare('DELETE FROM chunk_vectors WHERE rowid=?');
    const addChunk = this.db.prepare(
      'INSERT INTO chunks(doc_id,chunk_index,body,embedding_input,section,token_count,start_line,end_line) VALUES (?,?,?,?,?,?,?,?)',
    );
    const addVector = this.db.prepare('INSERT INTO chunk_vectors(rowid,embedding) VALUES (?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of this.db.prepare('SELECT id FROM chunks WHERE doc_id=?').all(document.id))
        removeVector.run(BigInt(number(row.id)));
      this.db.prepare('DELETE FROM chunks WHERE doc_id=?').run(document.id);
      this.db
        .prepare(
          'INSERT INTO documents(doc_id,source,source_path,generation) VALUES (?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET source=excluded.source,source_path=excluded.source_path,generation=excluded.generation',
        )
        .run(document.id, document.name, document.path, document.generation);
      chunks.forEach((chunk, index) => {
        const result = addChunk.run(
          document.id,
          chunk.index,
          chunk.body,
          chunk.embeddingInput,
          chunk.section,
          chunk.tokenCount,
          chunk.startLine,
          chunk.endLine,
        );
        const vector = vectors[index];
        if (!vector) throw new Error('A chunk vector is missing.');
        addVector.run(BigInt(result.lastInsertRowid), vector);
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async search(vector: Vector, options: SearchOptions): Promise<SearchHit[]> {
    if (!Number.isInteger(options.limit) || options.limit < 1)
      throw new Error('Invalid search limit.');
    const rows = this.db
      .prepare(
        `WITH nearest AS (SELECT rowid,distance FROM chunk_vectors WHERE embedding MATCH ? AND k=?) SELECT chunks.*,documents.source,documents.source_path,documents.generation,nearest.distance FROM nearest JOIN chunks ON chunks.id=nearest.rowid JOIN documents ON documents.doc_id=chunks.doc_id ORDER BY nearest.distance,chunks.id`,
      )
      .all(this.vectorBlob(vector), BigInt(options.limit));
    return rows
      .map((row) => ({
        id: number(row.id),
        distance: number(row.distance),
        score: Math.max(-1, Math.min(1, 1 - number(row.distance))),
        document: {
          id: text(row.doc_id),
          name: text(row.source),
          path: text(row.source_path),
          generation: text(row.generation),
        },
        chunk: {
          index: number(row.chunk_index),
          body: text(row.body),
          embeddingInput: text(row.embedding_input),
          section: text(row.section),
          tokenCount: number(row.token_count),
          startLine: number(row.start_line),
          endLine: number(row.end_line),
        },
      }))
      .filter((hit) => options.minScore === undefined || hit.score >= options.minScore);
  }

  async stats(): Promise<SqliteStoreStats> {
    const version = this.db.prepare('SELECT sqlite_version() AS sqlite,vec_version() AS vec').get();
    return {
      path: this.path,
      sqliteVersion: text(version?.sqlite),
      vectorExtensionVersion: text(version?.vec),
      documents: number(this.db.prepare('SELECT count(*) AS n FROM documents').get()?.n),
      chunks: number(this.db.prepare('SELECT count(*) AS n FROM chunks').get()?.n),
      vectors: number(this.db.prepare('SELECT count(*) AS n FROM chunk_vectors').get()?.n),
    };
  }
  listChunks(documentId: string) {
    return this.db
      .prepare(
        'SELECT chunks.*,documents.generation FROM chunks JOIN documents ON documents.doc_id=chunks.doc_id WHERE chunks.doc_id=? ORDER BY chunk_index',
      )
      .all(documentId);
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
