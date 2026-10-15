import type { Collection, DocumentRecord, Principal } from '../api/contracts.generated';

/** These helpers control UI affordances. The server independently enforces every operation. */
export function canEditCollection(user: Principal | null, collection: Collection) {
  return (
    user?.role === 'admin' ||
    (user?.role === 'editor' &&
      collection.grants.some(
        (grant) =>
          grant.access === 'edit' &&
          (grant.subject === user.id || user.groups.some((id) => grant.subject === 'group:' + id)),
      ))
  );
}
export function canEditDocument(
  document: DocumentRecord,
  user: Principal | null,
  collections: Collection[],
) {
  return (
    (!!document.conversation && document.owner === user?.id) ||
    collections.some(
      (collection) => collection.id === document.collection && canEditCollection(user, collection),
    )
  );
}
