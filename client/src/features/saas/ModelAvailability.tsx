import type { ModelProfile } from '../../shared/api/contracts.generated';
import { api } from '../../shared/api/client';
import { useLoad } from '../../shared/lib/hooks';
import { Button } from '../../shared/ui/Button';
import { useState } from 'react';

/** Each check belongs to this profile revision and the current authenticated company. */
export function ModelAvailability({
  profile,
  refresh = 0,
}: {
  profile: ModelProfile;
  refresh?: number;
}) {
  const [requested, setRequested] = useState(0);
  const enabled = profile.enabled || requested > 0 || refresh > 0;
  const check = useLoad(
    async (signal) => {
      if (!enabled)
        return {
          ok: false,
          message: 'This profile is disabled and cannot be assigned to new tasks.',
          at: 0,
        };
      const status = await api('models.check', { id: profile.id }, { signal });
      return { ...status, at: Date.now() };
    },
    [profile.id, profile.revision, refresh, requested],
  );
  return (
    <div aria-label={`Availability: ${profile.name}`}>
      <p role="status">
        <strong>
          {!enabled
            ? 'Disabled'
            : check.loading
              ? 'Checking…'
              : check.error || !check.data?.ok
                ? 'Unavailable'
                : 'Available'}
        </strong>
        {!check.loading && (
          <>
            <br />
            {check.error || check.data?.message}
          </>
        )}
        {!check.loading && check.data && check.data.at > 0 && (
          <>
            <br />
            <small>Checked: {new Date(check.data.at).toLocaleTimeString()}</small>
          </>
        )}
      </p>
      <Button
        disabled={check.loading}
        onClick={() => {
          setRequested((value) => value + 1);
        }}
        aria-label={`Check availability: ${profile.name}`}
      >
        {enabled ? 'Check again' : 'Check connection'}
      </Button>
    </div>
  );
}
