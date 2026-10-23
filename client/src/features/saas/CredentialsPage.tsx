import { api } from '../../shared/api/client';
import { useLoad } from '../../shared/lib/hooks';
import { PageHeader } from '../../shared/ui/Feedback';
import { CredentialsPanel } from './CredentialsPanel';
export function Credentials() {
  const keys = useLoad((signal) => api('secrets.list', {}, { signal }));
  return (
    <>
      <PageHeader
        title={'API keys'}
        description={
          'Shared encrypted provider registry. Changes apply to models using the key across all companies.'
        }
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
