import { lazy, Suspense } from 'react';
import { observer } from 'mobx-react-lite';
import { useApplication } from '../../shared/lib/application-context';
import { EmptyState, Loading } from '../../shared/ui/Feedback';
import { Tabs } from '../../shared/ui/Tabs';
import { knowledgeTabs } from '../../app/navigation/navigation-store';
const Materials = lazy(() =>
  import('../documents/DocumentsPage').then((m) => ({ default: m.Documents })),
);
const Collections = lazy(() => import('./AccessPage').then((m) => ({ default: m.Collections })));
const Sources = lazy(() => import('../sync/SyncPage').then((m) => ({ default: m.Sync })));
const Quality = lazy(() => import('../quality/QualityPage').then((m) => ({ default: m.Quality })));

export const KnowledgeWorkspace = observer(function KnowledgeWorkspace() {
  const app = useApplication(),
    user = app.session.user;
  const editable = app.bases.items.some((base) => app.bases.canEdit(base));
  const tabs = Object.fromEntries(
    Object.entries(knowledgeTabs).filter(
      ([key]) => key === 'materials' || (key === 'sources' ? editable : user?.role === 'admin'),
    ),
  );
  const selected = app.navigation.tab;
  const content = !Object.hasOwn(tabs, selected) ? (
    <EmptyState
      title={'Section unavailable'}
      description={
        'Managing access and quality requires an administrator role. Folders can be connected to knowledge bases you can edit.'
      }
    />
  ) : selected === 'collections' ? (
    <Collections />
  ) : selected === 'sources' ? (
    <Sources />
  ) : selected === 'quality' ? (
    <Quality />
  ) : (
    <Materials />
  );
  return (
    <div className="page-content knowledge-workspace">
      <div className="admin-scope">
        <span>
          Company ·{' '}
          {app.session.tenants.find((tenant) => tenant.id === user?.tenant)?.name ?? 'Company'}
        </span>
        <span>Materials follow knowledge base access permissions</span>
      </div>
      <Suspense fallback={<Loading />}>
        {Object.keys(tabs).length > 1 ? (
          <Tabs
            label={'Knowledge base'}
            tabs={tabs}
            selected={selected}
            onChange={(tab) => app.selectTab(tab)}
          >
            <div key={selected}>{content}</div>
          </Tabs>
        ) : (
          content
        )}
      </Suspense>
    </div>
  );
});
