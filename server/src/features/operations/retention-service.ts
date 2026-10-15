import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { authorized, type ActionMap } from '../../application/action-registry.js';
import type { DataContext } from '../../application/data-context.js';
import type { Conversation, DocumentRecord, Principal } from '../../domain/entities.js';
import type { DocumentService } from '../documents/document-service.js';
export class RetentionService {
  constructor(
    private readonly data: DataContext,
    private readonly documents: DocumentService,
  ) {}
  readonly actions: ActionMap = { cleanup: authorized((user) => this.handleCleanup(user)) };
  cleanup() {
    const s = this.data.catalog.settings(),
      now = Date.now(),
      catalog = this.data.catalog,
      extracting = catalog.count(
        'job',
        "job_kind='document' AND state IN ('queued','extracting','ocr','indexing')",
      );
    let removed = 0;
    catalog.transaction(() => {
      removed += Number(catalog.prepare('DELETE FROM sessions WHERE expires<?').run(now).changes);
      removed += Number(
        catalog.prepare('DELETE FROM logs WHERE created<?').run(now - s.logDays * 86400_000)
          .changes,
      );
      catalog.prepare('DELETE FROM cache WHERE created<?').run(now - 86400_000);
      const conversations = catalog.find<Conversation>(
        'conversation',
        "updated<? AND NOT EXISTS(SELECT 1 FROM entities j WHERE j.kind='job' AND j.conversation=entities.id AND j.state IN ('queued','searching','generating','extracting','ocr','indexing'))",
        [now - s.historyDays * 86400_000],
      );
      for (const conversation of conversations) {
        for (const document of catalog.find<DocumentRecord>('document', 'conversation=?', [
          conversation.id,
        ]))
          this.documents.purge(document);
        removed += this.deleteConversation(conversation.id);
      }
      const expired =
          "kind='job' AND state IN ('complete','no_info','clarification','failed','cancelled','interrupted') AND updated<?",
        before = now - s.jobDays * 86400_000;
      catalog
        .prepare(`DELETE FROM events WHERE job IN (SELECT id FROM entities WHERE ${expired})`)
        .run(before);
      removed += Number(
        catalog
          .prepare(
            `DELETE FROM entities WHERE kind='evaluation_result' AND json_extract(body,'$.job') IN (SELECT id FROM entities WHERE ${expired})`,
          )
          .run(before).changes,
      );
      removed += Number(
        catalog.prepare(`DELETE FROM entities WHERE ${expired}`).run(before).changes,
      );
      removed += Number(
        catalog
          .prepare(
            'DELETE FROM source_fragments WHERE id IN (SELECT s.id FROM source_fragments s WHERE s.created<? AND NOT EXISTS(SELECT 1 FROM chunks c WHERE c.id=s.id) AND NOT EXISTS(SELECT 1 FROM source_usage u WHERE u.chunk=s.id) LIMIT 10000)',
          )
          .run(before).changes,
      );
      if (conversations.length) catalog.invalidate();
    });
    if (!extracting)
      for (const name of readdirSync(catalog.directory))
        if (name.startsWith('extract-')) {
          const path = join(catalog.directory, name);
          if (statSync(path).mtimeMs < now - s.tempHours * 3600_000) {
            rmSync(path, { recursive: true, force: true });
            removed++;
          }
        }
    return { removed };
  }
  deleteConversation(id: string) {
    const catalog = this.data.catalog;
    let count = 0;
    catalog
      .prepare(
        "DELETE FROM events WHERE job IN (SELECT id FROM entities WHERE kind='job' AND conversation=?)",
      )
      .run(id);
    count += Number(
      catalog
        .prepare(
          "DELETE FROM entities WHERE kind='feedback' AND json_extract(body,'$.turn') IN (SELECT id FROM entities WHERE kind='turn' AND conversation=?)",
        )
        .run(id).changes,
    );
    count += Number(
      catalog
        .prepare("DELETE FROM entities WHERE kind IN ('turn','job') AND conversation=?")
        .run(id).changes,
    );
    catalog.delete('conversation', id);
    return count + 1;
  }
  async handleCleanup(user: Principal) {
    this.data.auth.admin(user);
    return this.cleanup();
  }
}
