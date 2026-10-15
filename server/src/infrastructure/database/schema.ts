import { createHash } from 'node:crypto';
import { contractSignature } from '../../contracts/format.generated.js';
import type { DatabaseSync } from 'node:sqlite';
import { requireValue } from '../../shared/errors.js';
// Exactly one schema. Its fingerprint changes with tables and indexes; there are no migrations.
const schemaSQL = `    CREATE TABLE schema_metadata(signature TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE entities(
      kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),
      search_name TEXT NOT NULL,search_text TEXT NOT NULL,
      state TEXT GENERATED ALWAYS AS (coalesce(json_extract(body,'$.status'),json_extract(body,'$.state'))) STORED,
      parent TEXT GENERATED ALWAYS AS (json_extract(body,'$.parent')) STORED,
      question TEXT GENERATED ALWAYS AS (json_extract(body,'$.question')) STORED,
      owner TEXT GENERATED ALWAYS AS (json_extract(body,'$.owner')) STORED,
      collection TEXT GENERATED ALWAYS AS (json_extract(body,'$.collection')) STORED,
      conversation TEXT GENERATED ALWAYS AS (coalesce(json_extract(body,'$.conversation'),json_extract(body,'$.payload.conversation'))) STORED,
      document TEXT GENERATED ALWAYS AS (coalesce(json_extract(body,'$.document'),json_extract(body,'$.payload.document'))) STORED,
      active_version TEXT GENERATED ALWAYS AS (json_extract(body,'$.activeVersion')) STORED,
      signature TEXT GENERATED ALWAYS AS (json_extract(body,'$.signature')) STORED,
      checksum TEXT GENERATED ALWAYS AS (json_extract(body,'$.hash')) STORED,
      created INTEGER GENERATED ALWAYS AS (json_extract(body,'$.created')) STORED,
      updated INTEGER GENERATED ALWAYS AS (json_extract(body,'$.updated')) STORED,
      name TEXT GENERATED ALWAYS AS (coalesce(json_extract(body,'$.name'),json_extract(body,'$.login'),json_extract(body,'$.title'))) STORED,
      role TEXT GENERATED ALWAYS AS (json_extract(body,'$.role')) STORED,
      blocked INTEGER GENERATED ALWAYS AS (json_extract(body,'$.blocked')) STORED,
      job_kind TEXT GENERATED ALWAYS AS (json_extract(body,'$.kind')) STORED,
      PRIMARY KEY(kind,id));
    CREATE INDEX entities_queue ON entities(kind,job_kind,state,created);
    CREATE INDEX entities_owner ON entities(kind,owner,updated DESC);
    CREATE INDEX entities_conversation ON entities(kind,conversation,created);
    CREATE INDEX entities_parent ON entities(kind,conversation,parent,created);
    CREATE INDEX entities_document ON entities(kind,document,created DESC);
    CREATE INDEX entities_collection ON entities(kind,collection,state);
    CREATE INDEX entities_name ON entities(kind,search_name);
    CREATE INDEX entities_state ON entities(kind,state,created);
    CREATE INDEX entities_checksum ON entities(kind,checksum,document);
    CREATE INDEX entities_job ON entities(kind,json_extract(body,'$.job'),created);
    CREATE INDEX entities_roles ON entities(kind,role,blocked);

    CREATE TABLE originals(version TEXT PRIMARY KEY,length INTEGER NOT NULL CHECK(length>0 AND length<=104857600));
    CREATE TABLE original_blocks(version TEXT NOT NULL REFERENCES originals(version) ON DELETE CASCADE,part INTEGER NOT NULL CHECK(part>=0),bytes BLOB NOT NULL CHECK(typeof(bytes)='blob' AND length(bytes)>0 AND length(bytes)<=65536),PRIMARY KEY(version,part));
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user TEXT NOT NULL,expires INTEGER NOT NULL,created INTEGER NOT NULL);
    CREATE INDEX sessions_user ON sessions(user);
    CREATE TABLE chunks(id TEXT PRIMARY KEY,document TEXT NOT NULL,version TEXT NOT NULL,page INTEGER NOT NULL,section TEXT NOT NULL,body TEXT NOT NULL,vector BLOB NOT NULL CHECK(typeof(vector)='blob'));
    CREATE INDEX chunks_version ON chunks(version,page);
    CREATE INDEX chunks_document ON chunks(document,version);
    CREATE TABLE source_fragments(id TEXT PRIMARY KEY,document TEXT NOT NULL,version TEXT NOT NULL,page INTEGER NOT NULL,section TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE INDEX source_fragments_document ON source_fragments(document,version);
    CREATE INDEX source_fragments_version ON source_fragments(version,page);
    CREATE INDEX source_fragments_created ON source_fragments(created);
    CREATE TABLE source_usage(kind TEXT NOT NULL,entity TEXT NOT NULL,chunk TEXT NOT NULL,PRIMARY KEY(kind,entity,chunk),FOREIGN KEY(kind,entity) REFERENCES entities(kind,id) ON DELETE CASCADE);
    CREATE INDEX source_usage_chunk ON source_usage(chunk);
    CREATE TRIGGER entity_sources_insert AFTER INSERT ON entities BEGIN
      INSERT INTO source_usage SELECT NEW.kind,NEW.id,json_extract(value,'$.chunk') FROM json_each(NEW.body,'$.sources') WHERE json_type(value,'$.chunk')='text'
        UNION SELECT NEW.kind,NEW.id,json_extract(value,'$.chunk') FROM json_each(NEW.body,'$.accessSources') WHERE json_type(value,'$.chunk')='text';
    END;
    CREATE TRIGGER entity_sources_update AFTER UPDATE OF body ON entities WHEN json_extract(OLD.body,'$.sources') IS NOT json_extract(NEW.body,'$.sources') OR json_extract(OLD.body,'$.accessSources') IS NOT json_extract(NEW.body,'$.accessSources') BEGIN
      DELETE FROM source_usage WHERE kind=OLD.kind AND entity=OLD.id;
      INSERT INTO source_usage SELECT NEW.kind,NEW.id,json_extract(value,'$.chunk') FROM json_each(NEW.body,'$.sources') WHERE json_type(value,'$.chunk')='text'
        UNION SELECT NEW.kind,NEW.id,json_extract(value,'$.chunk') FROM json_each(NEW.body,'$.accessSources') WHERE json_type(value,'$.chunk')='text';
    END;
    CREATE VIRTUAL TABLE fulltext USING fts5(id UNINDEXED,body,title,tokenize='unicode61');
    CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job TEXT NOT NULL,created INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE INDEX events_job ON events(job,seq);
    CREATE TABLE cache(key TEXT PRIMARY KEY,created INTEGER NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),bytes INTEGER GENERATED ALWAYS AS (length(CAST(body AS BLOB))) STORED);
    CREATE INDEX cache_created ON cache(created);
    CREATE TABLE logs(id INTEGER PRIMARY KEY,created INTEGER NOT NULL,code TEXT NOT NULL,diagnostic TEXT NOT NULL);
`;
export const schemaVersion = 1;
const applicationId = 0x52414736;
const schemaSignature = createHash('sha256')
  .update(schemaSQL.replace(/\s+/gu, ' ').trim() + contractSignature)
  .digest('hex');
export function assertCurrentSchema(db: DatabaseSync) {
  let signature: unknown;
  try {
    signature = db.prepare('SELECT signature FROM schema_metadata').get()?.signature;
  } catch {
    signature = undefined;
  }
  requireValue(
    Number(db.prepare('PRAGMA user_version').get()?.user_version) === schemaVersion &&
      Number(db.prepare('PRAGMA application_id').get()?.application_id) === applicationId &&
      signature === schemaSignature,
    'SCHEMA_INCOMPATIBLE',
    'Схема данных несовместима с текущей версией. Выберите пустой каталог или копию текущего формата.',
    409,
  );
}
export function initializeSchema(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(schemaSQL);
    db.prepare('INSERT INTO schema_metadata VALUES (?)').run(schemaSignature);
    db.exec(
      `PRAGMA application_id=${applicationId}; PRAGMA user_version=${schemaVersion}; COMMIT;`,
    );
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
