import { api } from '../../shared/api/client';
import { useLoad } from '../../shared/lib/hooks';
import { PageHeader } from '../../shared/ui/Feedback';
import { CredentialsPanel } from './CredentialsPanel';
export function Credentials() {
  const keys = useLoad((signal) => api('secrets.list', {}, { signal }));
  return (
    <>
      <PageHeader
        title="API-ключи"
        description="Общий зашифрованный реестр поставщиков. Изменения действуют для использующих ключ моделей во всех компаниях."
      />
      <CredentialsPanel
        credentials={keys.data ?? []}
        loading={keys.loading}
        error={keys.error}
        reload={keys.reload}
        onChanged={keys.reload}
      />
    </>
  );
}
