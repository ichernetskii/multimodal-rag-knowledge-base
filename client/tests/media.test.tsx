import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MediaPreview } from '../src/features/documents/MediaPreview';
it('renders a protected still and original video at its source time', () => {
  const html = renderToStaticMarkup(
    <MediaPreview
      document="doc"
      version="v"
      media={{ kind: 'video', asset: 'clip', preview: 'frame', startMs: 12300, endMs: 12300 }}
    />,
  );
  expect(html).toContain('/api/documents/doc/media/frame?version=v');
  expect(html).toContain('/api/documents/doc?version=v#t=12.3');
  expect(html).toContain('0:12');
  expect(html).toContain('controls');
});
it('keeps speech playback and its limitations visible without pretending it is a still image', () => {
  const html = renderToStaticMarkup(
    <MediaPreview
      document="doc"
      version="v"
      media={{ kind: 'audio', startMs: 1000, endMs: 5000 }}
    />,
  );
  expect(html).toContain('<audio');
  expect(html).toContain('#t=1');
  expect(html).toContain('0:01–0:05');
  expect(html).toContain('фрагмент исходного материала');
  expect(html).not.toContain('<img');
});
