import { tenantUrl } from '../../shared/api/client';
import type { MediaReference } from '../../shared/api/contracts.generated';
import { useEffect, useState } from 'react';
export const mediaTime = (ms: number) => {
  const value = Math.max(0, Math.round(ms)),
    fraction = value % 1000;
  return `${Math.floor(value / 60000)}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')}${fraction ? '.' + String(fraction).padStart(3, '0').replace(/0+$/u, '') : ''}`;
};
export function MediaPreview({
  document,
  version,
  media,
}: {
  document: string;
  version: string;
  media?: MediaReference | undefined;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [document, version, media?.asset]);
  if (!media) return null;
  const url = tenantUrl(
      `/api/documents/${encodeURIComponent(document)}?version=${encodeURIComponent(version)}`,
    ),
    original = url + (media.startMs === undefined ? '' : `#t=${media.startMs / 1000}`),
    // Prepared clips already start at zero; timestamps refer to the complete original.
    timed = media.asset
      ? tenantUrl(
          `/api/documents/${encodeURIComponent(document)}/media/${encodeURIComponent(media.asset)}?version=${encodeURIComponent(version)}`,
        )
      : original,
    image = media.kind === 'image' ? media.asset : media.preview;
  return (
    <figure className="media-preview">
      {image && media.kind === 'image' && (
        <img
          loading="lazy"
          src={tenantUrl(
            `/api/documents/${encodeURIComponent(document)}/media/${encodeURIComponent(image)}?version=${encodeURIComponent(version)}`,
          )}
          alt="Source image"
          onError={() => setFailed(true)}
        />
      )}{' '}
      {media.kind === 'video' && (
        <video
          key={timed}
          controls
          preload="metadata"
          poster={
            image
              ? tenantUrl(
                  `/api/documents/${encodeURIComponent(document)}/media/${encodeURIComponent(image)}?version=${encodeURIComponent(version)}`,
                )
              : undefined
          }
          src={timed}
          onError={() => setFailed(true)}
        />
      )}{' '}
      {media.kind === 'audio' && (
        <audio
          key={timed}
          controls
          preload="metadata"
          src={timed}
          onError={() => setFailed(true)}
        />
      )}
      <figcaption>
        {media.kind === 'image'
          ? 'Original image. Check labels and details.'
          : `${mediaTime(media.startMs ?? 0)}${media.endMs !== undefined ? '–' + mediaTime(media.endMs) : ''} · ${media.kind === 'video' ? 'video segment; audio is available in audio segments and the original' : 'segment of the original recording'}`}
      </figcaption>
      {failed && (
        <p role="alert">
          Could not load the preview. The file may be unavailable or unsupported by your browser.
          Open the original or refresh the page.
        </p>
      )}
      {media.kind !== 'image' && media.startMs !== undefined && (
        <a href={original} target="_blank" rel="noopener">
          Open this position in the original ↗
        </a>
      )}
    </figure>
  );
}
