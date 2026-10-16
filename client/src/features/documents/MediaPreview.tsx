import { tenantUrl } from '../../shared/api/client';
import type { MediaReference } from '../../shared/api/contracts.generated';
export const mediaTime = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
export function MediaPreview({
  document,
  version,
  media,
}: {
  document: string;
  version: string;
  media?: MediaReference | undefined;
}) {
  if (!media) return null;
  const url = tenantUrl(
      `/api/documents/${encodeURIComponent(document)}?version=${encodeURIComponent(version)}`,
    ),
    timed = url + (media.startMs === undefined ? '' : `#t=${media.startMs / 1000}`),
    image = media.kind === 'image' ? media.asset : media.preview;
  return (
    <figure className="media-preview">
      {image && (
        <img
          loading="lazy"
          src={tenantUrl(
            `/api/documents/${encodeURIComponent(document)}/media/${encodeURIComponent(image)}?version=${encodeURIComponent(version)}`,
          )}
          alt={
            media.kind === 'video'
              ? `Кадр ${mediaTime(media.startMs ?? 0)}`
              : 'Изображение источника'
          }
        />
      )}{' '}
      {media.kind === 'video' && <video key={timed} controls preload="metadata" src={timed} />}{' '}
      {media.kind === 'audio' && <audio key={timed} controls preload="metadata" src={timed} />}
      <figcaption>
        {media.kind === 'image'
          ? 'Исходное изображение. Сверьте надписи и детали.'
          : `${mediaTime(media.startMs ?? 0)}${media.endMs !== undefined ? '–' + mediaTime(media.endMs) : ''} · фрагмент исходного материала`}
      </figcaption>
    </figure>
  );
}
