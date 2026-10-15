import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { authorized, type ActionMap } from '../../application/action-registry.js';
import type { DataContext } from '../../application/data-context.js';
import type { RuntimeState } from '../../application/runtime-state.js';
import type {
  DocumentRecord,
  DocumentPreview,
  Job,
  Principal,
  Page,
  Turn,
  Version,
} from '../../domain/entities.js';
import { extract } from '../../infrastructure/extraction/extract.js';
import {
  storeOriginal,
  readOriginal,
  originalRange,
} from '../../infrastructure/database/original-store.js';
import { encodeVector } from '../../infrastructure/indexing/vector-codec.js';
import { requireValue } from '../../shared/errors.js';
import { hash } from '../../shared/hash.js';
import type { Input } from '../../shared/input.js';
import { number, object, revision, scope, string, strings, supported } from '../../shared/input.js';
import { pagination } from '../../shared/pagination.js';
import type { AccessPolicy } from '../identity/access-policy.js';
import type { JobService } from '../jobs/job-service.js';

export class DocumentService {
  constructor(
    private readonly data: DataContext,
    private readonly access: AccessPolicy,
    private readonly jobs: JobService,
    private readonly state: RuntimeState,
  ) {}
  readonly actions: ActionMap = {
    'sources.read': authorized((user, p) => this.handleSourceRead(user, p)),
    'documents.list': authorized((user, p) => this.handleDocumentsList(user, p)),
    'documents.limits': authorized(() => this.handleDocumentsLimits()),
    'documents.read': authorized((user, p) => this.handleDocumentsRead(user, p)),
    'documents.preview': authorized((user, p) => this.handleDocumentsPreview(user, p)),
    'documents.upload': authorized((user, p) => this.handleDocumentsUpload(user, p)),
    'documents.publish': authorized((user, p) => this.handleDocumentsPublish(user, p)),
    'documents.update': authorized((user, p) => this.handleDocumentsUpdate(user, p)),
    'documents.bulk': authorized((user, p) => this.handleDocumentsBulk(user, p)),
    'documents.delete': authorized((user, p) => this.handleDocumentsDelete(user, p)),
    'documents.restore': authorized((user, p) => this.handleDocumentsRestore(user, p)),
    'documents.compare': authorized((user, p) => this.handleDocumentsCompare(user, p)),
  };
  list(user: Principal, p: Input) {
    const access = this.data.auth.documentScope(user),
      f = scope(object(p, 'scope')),
      q = string(p, 'query').toLowerCase(),
      state = string(p, 'state'),
      sort = string(p, 'sort', 'name'),
      page = pagination(p);
    requireValue(
      ['name', 'updated', 'state'].includes(sort),
      'INVALID_INPUT',
      'Неподдерживаемая сортировка.',
    );
    const where = `${access.where} AND (?='' OR instr(search_name,?)>0) AND (?='' OR state=?) AND (?='' OR collection=?) AND (?='' OR conversation=?)`;
    const params = [
      ...access.params,
      q,
      q,
      state,
      state,
      f.collection ?? '',
      f.collection ?? '',
      f.conversation ?? '',
      f.conversation ?? '',
    ];
    const total = this.data.catalog.count('document', where, params);
    const order =
      sort === 'updated'
        ? "coalesce((SELECT max(v.created) FROM entities v WHERE v.kind='version' AND v.document=entities.id),0) DESC"
        : sort === 'state'
          ? 'state,search_name'
          : 'search_name';
    const docs = this.data.catalog.find<DocumentRecord>(
      'document',
      where,
      params,
      order,
      page.pageSize,
      page.offset,
    );
    const ids = JSON.stringify(docs.map((d) => d.id));
    const jobs = this.data.catalog
      .prepare(
        "SELECT body FROM (SELECT body,row_number() OVER(PARTITION BY document ORDER BY created DESC,id DESC) AS position FROM entities WHERE kind='job' AND job_kind='document' AND document IN (SELECT value FROM json_each(?))) WHERE position=1",
      )
      .all(ids)
      .map((row) => JSON.parse(String(row.body)) as Job);
    const byDocument = new Map(jobs.map((job) => [String(job.payload.document), job]));
    const versions = this.data.catalog
      .prepare(
        "SELECT document,count(*) AS count,max(created) AS updated FROM entities WHERE kind='version' AND document IN (SELECT value FROM json_each(?)) GROUP BY document",
      )
      .all(ids);
    const byVersion = new Map(versions.map((v) => [String(v.document), v]));
    return {
      items: docs.map((doc) => {
        const job = byDocument.get(doc.id),
          version = byVersion.get(doc.id);
        return {
          ...doc,
          versionCount: Number(version?.count ?? 0),
          updated: Number(version?.updated ?? 0),
          processing: job
            ? {
                id: job.id,
                status: job.status,
                paused: job.payload.paused === true,
                reviewRequired: job.result.reviewRequired === true,
                error: job.error,
                diagnostic: job.diagnostic,
              }
            : null,
        };
      }),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  read(user: Principal, p: Input) {
    const doc = this.data.auth.document(user, string(p, 'id'));
    const versions = this.data.catalog
      .prepare(
        "SELECT id,created,state,checksum AS hash FROM entities WHERE kind='version' AND document=? ORDER BY created DESC",
      )
      .all(doc.id) as unknown as {
      id: string;
      created: number;
      state: Version['state'];
      hash: string;
    }[];
    const vid = string(p, 'version') || doc.activeVersion || versions[0]?.id || '';
    const v = this.data.catalog.get<Version>('version', vid);
    requireValue(v && v.document === doc.id, 'NOT_FOUND', 'Версия не найдена.', 404);
    let canReview = Boolean(doc.conversation);
    if (!doc.conversation)
      try {
        this.data.auth.collection(user, doc.collection, true);
        canReview = true;
      } catch {
        canReview = false;
      }
    requireValue(canReview || v.state === 'ready', 'FORBIDDEN', 'Версия ещё не опубликована.', 403);
    return {
      document: doc,
      version: v,
      versions: versions
        .filter((x) => canReview || x.state === 'ready')
        .map((x) => ({
          id: x.id,
          created: x.created,
          state: x.state,
          hash: x.hash,
        })),
    };
  }

  async handleSourceRead(user: Principal, p: Input) {
    const chunk = this.data.catalog
      .prepare(
        'SELECT id,document,version,page,section,body FROM chunks WHERE id=? UNION ALL SELECT id,document,version,page,section,body FROM source_fragments WHERE id=? LIMIT 1',
      )
      .get(string(p, 'chunk'), string(p, 'chunk'));
    requireValue(chunk, 'NOT_FOUND', 'Фрагмент не найден.', 404);
    const document = this.data.auth.document(user, String(chunk.document));
    const version = this.data.catalog
      .prepare(
        "SELECT id,document,created,state,checksum AS hash,name FROM entities WHERE kind='version' AND id=?",
      )
      .get(String(chunk.version));
    requireValue(
      version && version.document === document.id && version.state === 'ready',
      'NOT_FOUND',
      'Источник не опубликован.',
      404,
    );
    const row = this.data.catalog
      .prepare(
        "SELECT value FROM entities,json_each(entities.body,'$.pages') WHERE kind='version' AND entities.id=? AND json_extract(value,'$.number')=? LIMIT 1",
      )
      .get(String(chunk.version), Number(chunk.page));
    requireValue(row, 'NOT_FOUND', 'Страница не найдена.', 404);
    return {
      document,
      version: {
        id: String(version.id),
        created: Number(version.created),
        state: 'ready' as const,
        hash: String(version.hash),
        name: String(version.name),
      },
      page: JSON.parse(String(row.value)) as Page,
      source: {
        id: 1,
        chunk: String(chunk.id),
        document: document.id,
        version: String(chunk.version),
        name: document.name,
        page: Number(chunk.page),
        section: String(chunk.section),
        text: String(chunk.body),
      },
    };
  }

  original(user: Principal, id: string, version: string) {
    const doc = this.data.auth.document(user, id);
    const row = this.data.catalog
      .prepare(
        "SELECT v.id,v.state,v.name,o.length FROM entities v JOIN originals o ON o.version=v.id WHERE v.kind='version' AND v.document=? AND (?='' OR v.id=?) ORDER BY (v.id=?) DESC,v.created DESC LIMIT 1",
      )
      .get(id, version, version, doc.activeVersion);
    requireValue(row, 'NOT_FOUND', 'Оригинал не найден.', 404);
    if (row.state !== 'ready' && !doc.conversation)
      this.data.auth.collection(user, doc.collection, true);
    return {
      document: id,
      version: String(row.id),
      name: String(row.name),
      length: Number(row.length),
    };
  }
  originalChunk(user: Principal, id: string, version: string, offset: number, length: number) {
    const original = this.original(user, id, version);
    requireValue(
      Number.isInteger(offset) &&
        offset >= 0 &&
        Number.isInteger(length) &&
        length > 0 &&
        length <= 65536 &&
        offset + length <= original.length,
      'INVALID_RANGE',
      'Некорректный диапазон файла.',
    );
    return originalRange(this.data.catalog, version, offset, length);
  }

  preview(user: Principal, p: Input) {
    const collection = string(p, 'collection');
    const conversation = string(p, 'conversation');
    if (conversation) this.access.owns(user, conversation);
    else this.data.auth.collection(user, collection, true);
    const files = p.files;
    requireValue(
      Array.isArray(files) && files.length <= 100,
      'INVALID_INPUT',
      'Передайте до 100 файлов.',
    );
    let projected = this.data.catalog.count('document');
    const access = this.data.auth.documentScope(user);
    const docs = this.data.catalog.find<DocumentRecord>(
      'document',
      `${access.where} AND collection=? AND conversation=?`,
      [...access.params, collection, conversation],
    );
    const byName = new Map(docs.map((d) => [d.name, d]));
    const byId = new Map(docs.map((d) => [d.id, d]));
    const ids = JSON.stringify(docs.map((d) => d.id));
    const versions = this.data.catalog
      .prepare(
        "SELECT document,checksum FROM entities WHERE kind='version' AND document IN (SELECT value FROM json_each(?))",
      )
      .all(ids);
    const byHash = new Map(
      versions.map((v) => [String(v.checksum), byId.get(String(v.document))!]),
    );
    const incoming = new Set<string>();
    return files.map<DocumentPreview>((item: unknown) => {
      requireValue(item && typeof item === 'object', 'INVALID_INPUT', 'Некорректный файл.');
      const f = item as Input;
      const name = basename(string(f, 'name'));
      const bytes = number(f, 'bytes');
      const digest = string(f, 'hash');
      requireValue(
        Number.isInteger(bytes) &&
          bytes >= 0 &&
          (!supported(name) ||
            bytes > this.data.catalog.settings().maxBytes ||
            /^[a-f0-9]{64}$/u.test(digest)),
        'INVALID_INPUT',
        'Некорректный размер или SHA-256 файла.',
      );
      const duplicate = byHash.get(digest);
      const repeated = incoming.has(digest);
      incoming.add(digest);
      const update = byName.get(name);
      return {
        name,
        status: !supported(name)
          ? 'unsupported'
          : bytes > this.data.catalog.settings().maxBytes
            ? 'limit'
            : duplicate || repeated
              ? 'duplicate'
              : !update && ++projected > this.data.catalog.settings().maxDocuments
                ? 'limit'
                : update
                  ? 'update'
                  : 'new',
        document: duplicate?.id ?? update?.id ?? '',
        revision: duplicate?.revision ?? update?.revision ?? 0,
      };
    });
  }

  upload(user: Principal, p: Input) {
    this.data.capacity();
    const collection = string(p, 'collection');
    const conversation = string(p, 'conversation');
    if (conversation) this.access.owns(user, conversation);
    else this.data.auth.collection(user, collection, true);
    const name = basename(string(p, 'name'));
    requireValue(supported(name), 'UNSUPPORTED_FORMAT', 'Поддерживаются PDF, MD и TXT.');
    const encoded = string(p, 'base64', '', this.data.catalog.settings().maxBytes * 2);
    requireValue(
      /^[A-Za-z0-9+/]*={0,2}$/u.test(encoded),
      'INVALID_INPUT',
      'Некорректные данные файла.',
    );
    const bytes = Buffer.from(encoded, 'base64');
    requireValue(
      bytes.length > 0 && bytes.length <= this.data.catalog.settings().maxBytes,
      'FILE_LIMIT',
      'Размер файла превышает лимит.',
    );
    const digest = hash(bytes);
    const id = string(p, 'document', randomUUID());
    let doc = this.data.catalog.get<DocumentRecord>('document', id);
    if (p.document !== undefined)
      requireValue(
        doc,
        'NOT_FOUND',
        'Для новой загрузки не указывайте document; для обновления нужен существующий ID.',
        404,
      );
    if (doc) {
      this.data.auth.document(user, id, true);
      revision(p, doc);
      requireValue(
        doc.collection === collection && doc.conversation === conversation,
        'INVALID_SCOPE',
        'Нельзя менять область доступа загрузкой.',
      );
    } else {
      const access = this.data.auth.documentScope(user);
      const duplicate = this.data.catalog.find<DocumentRecord>(
        'document',
        `${access.where} AND collection=? AND conversation=? AND EXISTS(SELECT 1 FROM entities v WHERE v.kind='version' AND v.document=entities.id AND v.checksum=?)`,
        [...access.params, collection, conversation, digest],
        'id',
        1,
      )[0];
      if (duplicate) return { duplicate: duplicate.id, document: duplicate };
      requireValue(
        this.data.catalog.count('document') < this.data.catalog.settings().maxDocuments,
        'DOCUMENT_LIMIT',
        'Превышен лимит документов.',
      );
      doc = {
        id,
        name,
        collection,
        conversation,
        owner: user.id,
        revision: 0,
        activeVersion: '',
        state: 'draft',
      };
    }
    requireValue(
      !this.data.catalog.count(
        'job',
        "job_kind='document' AND document=? AND state IN ('queued','extracting','ocr','indexing')",
        [id],
      ),
      'DOCUMENT_BUSY',
      'Документ уже обрабатывается.',
      409,
    );
    const v: Version = {
      id: randomUUID(),
      document: id,
      name,
      hash: digest,
      created: Date.now(),
      pages: [],
      state: 'pending',
      acknowledged: false,
      signature: '',
    };
    doc.revision++;
    const savedDoc = doc;
    return this.data.catalog.transaction(() => {
      this.data.catalog.put('document', savedDoc);
      this.data.catalog.put('version', v);
      storeOriginal(this.data.catalog, v.id, bytes);
      this.data.catalog.invalidate();
      return {
        document: savedDoc,
        version: v,
        job: this.jobs.create(user, 'document', {
          document: id,
          version: v.id,
          revision: savedDoc.revision,
          stage: 'extract',
        }),
      };
    });
  }

  purge(d: DocumentRecord) {
    const references = this.data.catalog
        .prepare(
          'SELECT DISTINCT u.kind,u.entity FROM source_usage u JOIN source_fragments s ON s.id=u.chunk WHERE s.document=?',
        )
        .all(d.id),
      turnIds = JSON.stringify(
        references.filter((row) => row.kind === 'turn').map((row) => String(row.entity)),
      ),
      feedbackIds = JSON.stringify(
        references.filter((row) => row.kind === 'feedback').map((row) => String(row.entity)),
      ),
      resultIds = JSON.stringify(
        references
          .filter((row) => row.kind === 'evaluation_result')
          .map((row) => String(row.entity)),
      );
    for (const job of this.data.catalog.find<Job>('job', 'document=?', [d.id])) {
      this.state.active.get(job.id)?.abort();
      this.data.catalog.prepare('DELETE FROM events WHERE job=?').run(job.id);
      this.data.catalog.delete('job', job.id);
    }
    for (const version of this.data.catalog
      .prepare("SELECT id FROM entities WHERE kind='version' AND document=?")
      .all(d.id)) {
      this.data.catalog.prepare('DELETE FROM originals WHERE version=?').run(String(version.id));
      this.data.catalog.delete('version', String(version.id));
    }
    this.data.catalog
      .prepare('DELETE FROM fulltext WHERE id IN (SELECT id FROM chunks WHERE document=?)')
      .run(d.id);
    this.data.catalog.prepare('DELETE FROM chunks WHERE document=?').run(d.id);
    this.data.catalog.prepare('DELETE FROM source_fragments WHERE document=?').run(d.id);
    this.data.catalog.delete('document', d.id);
    // Derived answers can disclose the deleted source; remove them and feedback references.
    const turns = this.data.catalog.find<Turn>('turn', 'id IN (SELECT value FROM json_each(?))', [
      turnIds,
    ]);
    for (const turn of turns) {
      turn.answer = 'Источник окончательно удалён.';
      turn.sources = [];
      turn.accessSources = [];
      turn.status = 'interrupted';
      this.data.catalog.put('turn', turn);
      this.state.active.get(turn.job)?.abort();
      const job = this.data.catalog.get<Job>('job', turn.job);
      if (job)
        this.jobs.update(job, { result: { reason: 'SOURCE_DELETED' }, status: 'interrupted' });
    }
    this.data.catalog
      .prepare(
        "DELETE FROM entities WHERE kind='feedback' AND id IN (SELECT value FROM json_each(?))",
      )
      .run(feedbackIds);
    this.data.catalog
      .prepare(
        "DELETE FROM entities WHERE kind='check' AND EXISTS(SELECT 1 FROM json_each(body,'$.documents') document WHERE document.value=?)",
      )
      .run(d.id);
    const affected = this.data.catalog
      .prepare(
        "SELECT id,json_extract(body,'$.job') AS job FROM entities WHERE kind='evaluation_result' AND (id IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM json_each(body,'$.expected.documents') d WHERE d.value=?))",
      )
      .all(resultIds, d.id);
    for (const result of affected) {
      this.data.catalog.delete('evaluation_result', String(result.id));
      const job = this.data.catalog.get<Job>('job', String(result.job));
      if (job)
        this.jobs.update(job, { result: { reason: 'SOURCE_DELETED' }, status: 'interrupted' });
    }
  }

  async process(job: Job, user: Principal, signal: AbortSignal) {
    const doc = this.data.auth.document(user, string(job.payload, 'document'), true);
    const v = this.data.catalog.get<Version>('version', string(job.payload, 'version'));
    requireValue(v && v.document === doc.id, 'NOT_FOUND', 'Версия не найдена.');
    revision(job.payload, doc);
    if (job.payload.stage === 'extract') {
      this.jobs.update(job, { status: 'extracting' });
      const bytes = readOriginal(this.data.catalog, v.id);
      v.pages = await extract(v.name, bytes, this.data.catalog.settings(), signal, () =>
        this.jobs.update(job, { status: 'ocr' }),
      );
      signal.throwIfAborted();
      v.state = v.pages.some((p) => p.warnings.length) ? 'review' : 'pending';
      this.data.catalog.put('version', v);
      if (v.state === 'review') {
        this.jobs.update(job, {
          status: 'complete',
          result: { document: doc.id, version: v.id, reviewRequired: true },
        });
        return;
      }
    }
    requireValue(
      v.pages.length &&
        v.pages.every((p) => p.text.trim() && !p.warnings.includes('OCR_UNAVAILABLE_OR_FAILED')),
      'CONTENT_LOSS',
      'Не извлечён текст некоторых страниц.',
    );
    this.jobs.update(job, { status: 'indexing' });
    const signature = await this.data.models.signature();
    const fragments = await this.data.models.index(doc.name, v.pages, signal, {
      maxChunks: this.data.catalog.settings().maxChunks,
      beforeBatch: async () => {
        while (
          this.data.catalog.settings().pauseIndexing ||
          this.data.catalog.settings().pauseQueue
        ) {
          signal.throwIfAborted();
          if (job.payload.paused !== true) {
            job.payload.paused = true;
            this.jobs.update(job, {});
          }
          await new Promise<void>((r) => setTimeout(r, 250));
        }
        if (job.payload.paused) {
          job.payload.paused = false;
          this.jobs.update(job, {});
        }
      },
    });
    signal.throwIfAborted();
    const fresh = this.data.auth.document(this.data.auth.current(user.id), doc.id, true);
    revision(job.payload, fresh);
    requireValue(
      fragments.length <= this.data.catalog.settings().maxChunks,
      'CHUNK_LIMIT',
      'Превышен лимит фрагментов документа.',
    );
    requireValue(fragments.length, 'EMPTY_DOCUMENT', 'Документ не содержит индексируемого текста.');
    this.data.catalog.transaction(() => {
      this.data.catalog
        .prepare('DELETE FROM fulltext WHERE id IN (SELECT id FROM chunks WHERE version=?)')
        .run(v.id);
      this.data.catalog.prepare('DELETE FROM chunks WHERE version=?').run(v.id);
      for (const f of fragments) {
        const id = randomUUID();
        this.data.catalog
          .prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?,?)')
          .run(id, doc.id, v.id, f.page, f.section, f.body, encodeVector(f.vector));
        this.data.catalog
          .prepare('INSERT INTO fulltext(id,body,title) VALUES (?,?,?)')
          .run(id, f.body, fresh.name + ' ' + f.section);
      }
      v.signature = signature;
      v.state = 'ready';
      if (job.payload.activate !== false) {
        fresh.activeVersion = v.id;
        fresh.state = 'published';
      }
      fresh.revision++;
      this.data.catalog.put('version', v);
      this.data.catalog.put('document', fresh);
      this.data.catalog.invalidate();
      this.jobs.update(job, {
        status: 'complete',
        result: { document: doc.id, version: v.id, chunks: fragments.length },
      });
    });
  }

  async handleDocumentsList(user: Principal, p: Input) {
    return this.list(user, p);
  }

  async handleDocumentsLimits() {
    return {
      maxBytes: this.data.catalog.settings().maxBytes,
      maxDocuments: this.data.catalog.settings().maxDocuments,
      supported: ['pdf', 'md', 'markdown', 'txt'],
    };
  }

  async handleDocumentsRead(user: Principal, p: Input) {
    return this.read(user, p);
  }

  async handleDocumentsPreview(user: Principal, p: Input) {
    return this.preview(user, p);
  }

  async handleDocumentsUpload(user: Principal, p: Input) {
    return this.upload(user, p);
  }

  async handleDocumentsPublish(user: Principal, p: Input) {
    const doc = this.data.auth.document(user, string(p, 'id'), true);
    revision(p, doc);
    const v = this.data.catalog.get<Version>('version', string(p, 'version'));
    requireValue(
      v && v.document === doc.id && v.pages.length,
      'NOT_READY',
      'Сначала дождитесь извлечения текста.',
    );
    requireValue(
      v.pages.every((pg) => pg.text.trim() && !pg.warnings.includes('OCR_UNAVAILABLE_OR_FAILED')),
      'CONTENT_LOSS',
      'Не извлечён текст некоторых страниц. Загрузите исправленный документ.',
    );
    requireValue(
      v.state !== 'review' || p.acknowledge === true,
      'REVIEW_REQUIRED',
      'Подтвердите проверку страниц OCR.',
    );
    v.acknowledged = true;
    this.data.catalog.put('version', v);
    return this.jobs.create(user, 'document', {
      document: doc.id,
      version: v.id,
      stage: 'index',
      activate: p.activate !== false,
      revision: doc.revision,
    });
  }

  async handleDocumentsUpdate(user: Principal, p: Input) {
    const doc = this.data.auth.document(user, string(p, 'id'), true);
    revision(p, doc);
    const state = string(p, 'state', doc.state);
    requireValue(
      ['published', 'excluded', 'archived', 'draft'].includes(state),
      'INVALID_INPUT',
      'Некорректное состояние.',
    );
    requireValue(
      state !== 'published' ||
        this.data.catalog.get<Version>('version', doc.activeVersion)?.state === 'ready',
      'NOT_READY',
      'Документ ещё не обработан.',
    );
    const previousState = doc.state;
    doc.name = string(p, 'name', doc.name);
    requireValue(doc.name.trim(), 'INVALID_INPUT', 'Введите название документа.');
    return this.data.catalog.transaction(() => {
      this.data.catalog
        .prepare(
          "UPDATE fulltext SET title=? || ' ' || (SELECT section FROM chunks WHERE chunks.id=fulltext.id) WHERE id IN (SELECT id FROM chunks WHERE document=?)",
        )
        .run(doc.name, doc.id);
      doc.state = state as DocumentRecord['state'];
      doc.revision++;
      this.data.catalog.put('document', doc);
      this.data.catalog.invalidate(
        previousState !== doc.state && (previousState === 'draft' || doc.state === 'draft'),
      );
      return doc;
    });
  }

  async handleDocumentsBulk(user: Principal, p: Input) {
    const ids = strings(p, 'ids');
    const docs = ids.map((id) => this.data.auth.document(user, id, true));
    const revisions = object(p, 'revisions');
    docs.forEach((d) => revision({ revision: revisions[d.id] }, d));
    const operation = string(p, 'operation');
    requireValue(
      ['archive', 'exclude', 'delete'].includes(operation),
      'INVALID_INPUT',
      'Некорректная операция.',
    );
    this.data.catalog.transaction(() => {
      for (const d of docs)
        if (operation === 'delete') this.purge(d);
        else {
          d.state = operation === 'archive' ? 'archived' : 'excluded';
          d.revision++;
          this.data.catalog.put('document', d);
        }
      this.data.catalog.invalidate(operation === 'delete');
    });
    return { count: docs.length };
  }

  async handleDocumentsDelete(user: Principal, p: Input) {
    const d = this.data.auth.document(user, string(p, 'id'), true);
    revision(p, d);
    this.data.catalog.transaction(() => {
      this.purge(d);
      this.data.catalog.invalidate(true);
    });
    return { ok: true };
  }

  async handleDocumentsRestore(user: Principal, p: Input) {
    const d = this.data.auth.document(user, string(p, 'id'), true);
    revision(p, d);
    const v = this.data.catalog.get<Version>('version', string(p, 'version'));
    requireValue(v && v.document === d.id && v.state === 'ready', 'NOT_READY', 'Версия не готова.');
    requireValue(
      v.signature === (await this.data.models.signature()),
      'INDEX_INCOMPATIBLE',
      'Повторно индексируйте версию новой моделью.',
      409,
    );
    revision(p, this.data.auth.document(user, d.id, true));
    d.activeVersion = v.id;
    d.state = 'published';
    d.revision++;
    this.data.catalog.put('document', d);
    this.data.catalog.invalidate();
    return d;
  }

  async handleDocumentsCompare(user: Principal, p: Input) {
    const d = this.data.auth.document(user, string(p, 'id'));
    const versions = [string(p, 'left'), string(p, 'right')].map(
      (id) => this.read(user, { id: d.id, version: id }).version,
    );
    requireValue(
      versions.every((v) => v?.document === d.id),
      'NOT_FOUND',
      'Версия не найдена.',
      404,
    );
    return { left: versions[0]!.pages, right: versions[1]!.pages };
  }
}
