import { createHash } from 'node:crypto';
import { contractSignature } from '../../contracts/format.generated.js';
export const resourceTables = [
  'invitation',
  'group',
  'collection',
  'conversation',
  'document',
  'version',
  'turn',
  'job',
  'feedback',
  'check_question',
  'evaluation',
  'sync',
  'model',
  'index_build',
  'upload',
  'backup',
  'audit',
] as const;
export type ResourceTable = (typeof resourceTables)[number];
export const schemaSQL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE app_format(signature text PRIMARY KEY);
CREATE TABLE users(id uuid PRIMARY KEY,login text UNIQUE NOT NULL,password text NOT NULL,operator boolean NOT NULL DEFAULT false,blocked boolean NOT NULL DEFAULT false);
CREATE TABLE tenants(id uuid PRIMARY KEY,name text NOT NULL,blocked boolean NOT NULL DEFAULT false,maintenance boolean NOT NULL DEFAULT false,revision integer NOT NULL DEFAULT 1,settings jsonb NOT NULL,access_revision bigint NOT NULL DEFAULT 1,content_revision bigint NOT NULL DEFAULT 1);
CREATE TABLE memberships(tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users,role text NOT NULL CHECK(role IN ('user','editor','admin')),blocked boolean NOT NULL DEFAULT false,groups jsonb NOT NULL DEFAULT '[]',revision integer NOT NULL DEFAULT 1,PRIMARY KEY(tenant_id,user_id));
CREATE TABLE sessions(id text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,created bigint NOT NULL,expires bigint NOT NULL);
${resourceTables.map((table) => `CREATE TABLE ${table === 'group' ? 'groups' : table === 'check_question' ? 'check_questions' : table + 's'}(tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE,id uuid NOT NULL,body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),PRIMARY KEY(tenant_id,id));`).join('\n')}
ALTER TABLE documents ADD COLUMN collection_id uuid GENERATED ALWAYS AS (nullif(body->>'collection','')::uuid) STORED,
 ADD COLUMN conversation_id uuid GENERATED ALWAYS AS (nullif(body->>'conversation','')::uuid) STORED,
 ADD COLUMN owner_id uuid GENERATED ALWAYS AS ((body->>'owner')::uuid) STORED,
 ADD FOREIGN KEY(tenant_id,collection_id) REFERENCES collections ON DELETE CASCADE,
 ADD FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations ON DELETE CASCADE,
 ADD FOREIGN KEY(tenant_id,owner_id) REFERENCES memberships(tenant_id,user_id),
 ADD CHECK((collection_id IS NULL) <> (conversation_id IS NULL));
ALTER TABLE versions ADD COLUMN document_id uuid GENERATED ALWAYS AS ((body->>'document')::uuid) STORED,
 ADD FOREIGN KEY(tenant_id,document_id) REFERENCES documents ON DELETE CASCADE;
ALTER TABLE conversations ADD COLUMN owner_id uuid GENERATED ALWAYS AS ((body->>'owner')::uuid) STORED,
 ADD FOREIGN KEY(tenant_id,owner_id) REFERENCES memberships(tenant_id,user_id);
ALTER TABLE turns ADD COLUMN conversation_id uuid GENERATED ALWAYS AS ((body->>'conversation')::uuid) STORED,
 ADD FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations ON DELETE CASCADE;
CREATE INDEX documents_collection ON documents(tenant_id,collection_id);
CREATE INDEX versions_document ON versions(tenant_id,document_id);
CREATE INDEX turns_conversation ON turns(tenant_id,conversation_id,(body->>'created'));
CREATE INDEX jobs_status ON jobs(tenant_id,(body->>'status'),(body->>'kind'));
CREATE TABLE assets(tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE,id uuid NOT NULL,document_id uuid,version_id uuid,object_key text NOT NULL UNIQUE,name text NOT NULL,mime text NOT NULL,bytes bigint NOT NULL CHECK(bytes>0),sha256 text NOT NULL CHECK(length(sha256)=64),created bigint NOT NULL,PRIMARY KEY(tenant_id,id));
CREATE TABLE source_fragments(tenant_id uuid NOT NULL,id uuid NOT NULL,document_id uuid NOT NULL,version_id uuid NOT NULL,body jsonb NOT NULL,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,version_id) REFERENCES versions ON DELETE CASCADE);
CREATE TABLE chunks(tenant_id uuid NOT NULL,id uuid NOT NULL,index_id text NOT NULL,document_id uuid NOT NULL,version_id uuid NOT NULL,source_id uuid NOT NULL,text text NOT NULL,embedding vector NOT NULL,dimensions integer NOT NULL,fts tsvector GENERATED ALWAYS AS(to_tsvector('simple',text)) STORED,PRIMARY KEY(tenant_id,index_id,id),FOREIGN KEY(tenant_id,version_id) REFERENCES versions ON DELETE CASCADE,FOREIGN KEY(tenant_id,source_id) REFERENCES source_fragments ON DELETE CASCADE);
CREATE INDEX chunks_scope ON chunks(tenant_id,index_id,document_id,version_id);
CREATE INDEX chunks_fts ON chunks USING gin(fts);
CREATE INDEX chunks_hnsw_768 ON chunks USING hnsw((embedding::vector(768)) vector_cosine_ops) WHERE dimensions=768;
CREATE INDEX chunks_hnsw_3072 ON chunks USING hnsw((embedding::halfvec(3072)) halfvec_cosine_ops) WHERE dimensions=3072;
CREATE INDEX chunks_hnsw_1536 ON chunks USING hnsw((embedding::vector(1536)) vector_cosine_ops) WHERE dimensions=1536;
CREATE UNIQUE INDEX one_active_index ON index_builds(tenant_id) WHERE body->>'state'='active';
CREATE TABLE idempotency(tenant_id uuid NOT NULL,key text NOT NULL,request_hash text NOT NULL,result jsonb NOT NULL,created bigint NOT NULL,PRIMARY KEY(tenant_id,key));
CREATE TABLE usage_ledger(tenant_id uuid NOT NULL,id uuid NOT NULL,job_id uuid NOT NULL,profile text NOT NULL,state text NOT NULL CHECK(state IN('reserved','complete','uncertain','released')),reserved_micros bigint NOT NULL CHECK(reserved_micros>=0),input_tokens bigint NOT NULL DEFAULT 0,output_tokens bigint NOT NULL DEFAULT 0,cost_micros bigint NOT NULL DEFAULT 0 CHECK(cost_micros>=0),billing jsonb NOT NULL DEFAULT '{}',created bigint NOT NULL,PRIMARY KEY(tenant_id,id));
CREATE INDEX usage_month ON usage_ledger(tenant_id,created);
CREATE TABLE job_attempts(tenant_id uuid NOT NULL,job_id uuid NOT NULL,token uuid NOT NULL,expires bigint NOT NULL,PRIMARY KEY(tenant_id,job_id),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs ON DELETE CASCADE);
CREATE FUNCTION credential_references(requested text) RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT count(*) FROM public.models WHERE body->>'secretRef'=requested $$;
CREATE SEQUENCE credential_revision_seq AS integer;
CREATE TABLE ai_credentials(id text PRIMARY KEY,label text NOT NULL,provider text NOT NULL CHECK(provider IN ('google','anthropic','openai-compatible')),enabled boolean NOT NULL,revision integer NOT NULL,created bigint NOT NULL,updated bigint NOT NULL,ciphertext bytea NOT NULL,nonce bytea NOT NULL CHECK(octet_length(nonce)=12),tag bytea NOT NULL CHECK(octet_length(tag)=16));
CREATE TABLE credential_audits(id uuid PRIMARY KEY,credential text NOT NULL,action text NOT NULL,enabled boolean NOT NULL,actor uuid NOT NULL,actor_login text NOT NULL,created bigint NOT NULL);
CREATE INDEX credential_audits_recent ON credential_audits(created DESC,id);
CREATE INDEX models_secret_ref ON models((body->>'secretRef')) WHERE body->>'secretRef'<>'';
CREATE TABLE resource_leases(scope text NOT NULL,id uuid NOT NULL,expires bigint NOT NULL,PRIMARY KEY(scope,id));
CREATE TABLE rate_windows(scope text NOT NULL,window_start bigint NOT NULL,requests integer NOT NULL,tokens bigint NOT NULL,PRIMARY KEY(scope,window_start));
CREATE TABLE workers(id uuid PRIMARY KEY,kind text NOT NULL,last_seen bigint NOT NULL);
CREATE TABLE gc_objects(object_key text PRIMARY KEY,created bigint NOT NULL);
CREATE FUNCTION memberships_for_user(requested uuid) RETURNS TABLE(id uuid,name text,role text,blocked boolean,revision integer,groups jsonb) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT t.id,t.name,m.role,(t.blocked OR m.blocked),m.revision,m.groups FROM public.tenants t JOIN public.memberships m ON m.tenant_id=t.id WHERE m.user_id=requested ORDER BY t.name,t.id $$;
${['memberships', ...resourceTables.map((t) => (t === 'group' ? 'groups' : t === 'check_question' ? 'check_questions' : t + 's')), 'assets', 'source_fragments', 'chunks', 'idempotency', 'usage_ledger', 'job_attempts'].map((table) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY; CREATE POLICY tenant_scope ON ${table} USING (tenant_id::text=current_setting('rag.tenant',true)) WITH CHECK(tenant_id::text=current_setting('rag.tenant',true));`).join('\n')}
`;
export const schemaSignature = createHash('sha256')
  .update(schemaSQL)
  .update(contractSignature)
  .digest('hex');
