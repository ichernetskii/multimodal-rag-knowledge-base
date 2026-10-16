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
      title="Раздел недоступен"
      description="Для управления доступом и качеством нужна роль администратора. Подключать папки можно в базах с правом редактирования."
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
          Компания ·{' '}
          {app.session.tenants.find((tenant) => tenant.id === user?.tenant)?.name ?? 'Компания'}
        </span>
        <span>Материалы доступны в соответствии с правами на базу знаний</span>
      </div>
      <Suspense fallback={<Loading />}>
        {Object.keys(tabs).length > 1 ? (
          <Tabs
            label="База знаний"
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
