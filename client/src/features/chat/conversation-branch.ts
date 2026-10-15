import type { Turn } from '../../shared/api/contracts.generated';
export function conversationBranch<T extends Turn>(turns: T[], selected: string) {
  const result: T[] = [],
    seen = new Set<string>();
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  let id = selected;
  while (id && !seen.has(id)) {
    seen.add(id);
    const turn = byId.get(id);
    if (!turn) break;
    result.push(turn);
    id = turn.parent;
  }
  return result.reverse();
}
