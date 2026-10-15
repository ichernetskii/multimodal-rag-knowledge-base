import type { DataContext } from '../../application/data-context.js';
import type {
  Conversation,
  DocumentRecord,
  Principal,
  Source,
  Turn,
} from '../../domain/entities.js';
import { requireValue } from '../../shared/errors.js';

export class AccessPolicy {
  constructor(private readonly data: DataContext) {}

  owns(user: Principal, id: string) {
    const c = this.data.catalog.get<Conversation>('conversation', id);
    requireValue(c && c.owner === user.id, 'NOT_FOUND', 'Диалог не найден.', 404);
    return c;
  }

  source(user: Principal, s: Pick<Source, 'document' | 'version'>) {
    const doc = this.data.catalog.get<DocumentRecord>('document', s.document);
    return Boolean(
      doc &&
      this.data.auth.canRead(user, doc) &&
      this.data.catalog
        .prepare(
          "SELECT 1 FROM entities WHERE kind='version' AND id=? AND document=? AND state='ready'",
        )
        .get(s.version, s.document),
    );
  }

  turn(user: Principal, t: Turn) {
    if ([...t.sources, ...(t.accessSources ?? [])].some((s) => !this.source(user, s)))
      return {
        ...t,
        answer: 'Доступ к источникам этого ответа отозван.',
        sources: [],
        accessSources: [],
        redacted: true,
      };
    return t;
  }
}
