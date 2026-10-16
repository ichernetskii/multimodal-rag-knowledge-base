import type { Services } from '../../application/services.js';
import type {
  DocumentDetails,
  Job,
  Page,
  Principal,
  Source,
  Version,
} from '../../contracts/public.js';
import { requireValue } from '../../shared/errors.js';
import { number, string, type Input } from '../../shared/input.js';
import { findText, pageWindow } from './document-text.js';
import type { Documents } from './saas-documents.js';
import { presentPage } from './material-text.js';

/** Reading never sends every version or the entire extracted text to the browser. */
export class DocumentReader {
  constructor(
    private readonly s: Services,
    private readonly documents: Documents,
  ) {}

  async details(user: Principal, id: string, versionId = ''): Promise<DocumentDetails> {
    const document = await this.documents.document(user, id);
    const editable = await this.documents.canEdit(user, document);
    const versions = await this.s.db.query<{ version: Omit<Version, 'pages'> }>(
      `SELECT body-'pages'-'original' AS version FROM versions
       WHERE tenant_id=$1 AND document_id=$2 AND ($3 OR version_state='ready')
       ORDER BY created_at DESC,id DESC LIMIT 1000`,
      [user.tenant, id, editable],
    );
    const latest = versions[0]?.version;
    const selected =
      versionId || (editable && latest?.state !== 'ready' ? latest?.id : document.activeVersion);
    const version =
      versions.find((row) => row.version.id === selected)?.version ??
      (!versionId ? versions[0]?.version : undefined);
    requireValue(version, 'NOT_FOUND', 'Version not found.', 404);
    const pages = await this.s.db.query<DocumentDetails['pages'][number]>(
      `SELECT (page->>'number')::int AS number,page->>'method' AS method,
         page->'warnings' AS warnings,
         length(coalesce(page->'preparedText'->>'text',page->>'text',''))::int AS characters
       FROM versions CROSS JOIN LATERAL jsonb_array_elements(body->'pages') WITH ORDINALITY AS p(page,position)
       WHERE tenant_id=$1 AND id=$2 AND document_id=$3 ORDER BY position`,
      [user.tenant, version.id, id],
    );
    const [job] = await this.s.db.list<Job>(
      'job',
      "body->'payload'->>'version'=$2",
      [version.id],
      1,
    );
    const processing = job
      ? {
          id: job.id,
          status: job.status,
          reviewRequired: Boolean(job.result.reviewRequired),
          error: job.error,
          diagnostic: job.diagnostic,
          message: typeof job.result.message === 'string' ? job.result.message : '',
        }
      : null;
    return {
      document,
      version,
      pages,
      processing,
      versions: versions.map(({ version: item }) => ({
        id: item.id,
        created: item.created,
        state: item.state,
        hash: item.hash,
      })),
    };
  }

  private async pages(user: Principal, p: Input, onlyPage?: number) {
    const document = await this.documents.document(user, string(p, 'id'));
    const editable = await this.documents.canEdit(user, document);
    const [row] = await this.s.db.query<{ pages: Page[] }>(
      onlyPage === undefined
        ? `SELECT body->'pages' AS pages FROM versions WHERE tenant_id=$1 AND id=$2 AND document_id=$3 AND ($4 OR body->>'state'='ready')`
        : `SELECT jsonb_agg(page) AS pages FROM versions CROSS JOIN LATERAL jsonb_array_elements(body->'pages') AS p(page)
           WHERE tenant_id=$1 AND id=$2 AND document_id=$3 AND ($4 OR body->>'state'='ready') AND (page->>'number')::int=$5`,
      [
        user.tenant,
        string(p, 'version'),
        document.id,
        editable,
        ...(onlyPage === undefined ? [] : [onlyPage]),
      ],
    );
    requireValue(row?.pages, 'NOT_FOUND', 'Version or page not found.', 404);
    return row.pages;
  }

  async page(user: Principal, p: Input) {
    const page = number(p, 'page');
    requireValue(Number.isSafeInteger(page) && page >= 1, 'INVALID_INPUT', 'Invalid page number.');
    const [stored] = await this.pages(user, p, page);
    requireValue(stored, 'NOT_FOUND', 'Page not found.', 404);
    return pageWindow(stored, number(p, 'offset', 0), number(p, 'limit', 12000));
  }

  async find(user: Principal, p: Input) {
    const query = string(p, 'query', '', 200);
    const page = number(p, 'page', 1),
      pageSize = number(p, 'pageSize', 20);
    requireValue(
      Number.isSafeInteger(page) &&
        page >= 1 &&
        Number.isSafeInteger(pageSize) &&
        pageSize >= 1 &&
        pageSize <= 50,
      'INVALID_INPUT',
      'Invalid search page.',
    );
    const result = findText(await this.pages(user, p), query, (page - 1) * pageSize, pageSize);
    return { ...result, page, pageSize };
  }
  async compare(user: Principal, p: Input) {
    const id = string(p, 'id'),
      leftId = string(p, 'left'),
      rightId = string(p, 'right');
    const left = await this.details(user, id, leftId),
      right = await this.details(user, id, rightId);
    const page = number(p, 'page', 1),
      offset = number(p, 'offset', 0),
      limit = number(p, 'limit', 12000);
    requireValue(
      Number.isSafeInteger(page) && page >= 1 && Number.isSafeInteger(offset) && offset >= 0,
      'INVALID_INPUT',
      'Invalid comparison window.',
    );
    const window = async (version: string, exists: boolean) => {
      if (!exists) return null;
      const [stored] = await this.pages(user, { id, version }, page);
      requireValue(stored, 'NOT_FOUND', 'Page not found.', 404);
      return pageWindow(stored, Math.min(offset, presentPage(stored).text.length), limit);
    };
    return {
      left: await window(
        leftId,
        left.pages.some((item) => item.number === page),
      ),
      right: await window(
        rightId,
        right.pages.some((item) => item.number === page),
      ),
      pages: [...new Set([...left.pages, ...right.pages].map((item) => item.number))].sort(
        (a, b) => a - b,
      ),
    };
  }
  async sourcePage(user: Principal, source: Source) {
    const [stored] = await this.pages(
      user,
      { id: source.document, version: source.version },
      source.page,
    );
    requireValue(stored, 'NOT_FOUND', 'Page not found.', 404);
    const text = presentPage(stored).text,
      at = text.indexOf(source.text);
    return pageWindow(
      stored,
      Math.max(0, at - 1200),
      Math.min(32000, Math.max(2400, source.text.length + 2400)),
    );
  }
}
