import type { ModelProfile } from '../../shared/api/contracts.generated';
import { api } from '../../shared/api/client';
import { useLoad } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';

/** Each check belongs to this profile revision and the current authenticated company. */
export function ModelAvailability({
  profile,
  refresh = 0,
}: {
  profile: ModelProfile;
  refresh?: number;
}) {
  const check = useLoad(
    async (signal) => {
      const status = await api('models.check', { id: profile.id }, { signal });
      return { ...status, at: Date.now() };
    },
    [profile.id, profile.revision, refresh],
  );
  return (
    <div aria-label={`Доступность: ${profile.name}`}>
      <p role="status">
        <strong>
          {check.loading
            ? 'Проверяем…'
            : check.error || !check.data?.ok
              ? 'Недоступна'
              : 'Доступна'}
        </strong>
        {!check.loading && (
          <>
            <br />
            {check.error || check.data?.message}
          </>
        )}
        {!check.loading && check.data && (
          <>
            <br />
            <small>Проверено: {new Date(check.data.at).toLocaleTimeString()}</small>
          </>
        )}
      </p>
      <Button
        disabled={check.loading}
        onClick={check.reload}
        aria-label={`Проверить доступность: ${profile.name}`}
      >
        Проверить снова
      </Button>
    </div>
  );
}
