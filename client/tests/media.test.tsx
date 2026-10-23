import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MediaPreview } from '../src/features/documents/MediaPreview';
it('plays the protected normalized clip from zero and links the complete original at its source time', () => {
  const html = renderToStaticMarkup(
    <MediaPreview
      document="doc"
      version="v"
      media={{ kind: 'video', asset: 'clip', preview: 'frame', startMs: 12300, endMs: 13000 }}
    />,
  );
  expect(html).toContain('/api/documents/doc/media/frame?version=v');
  expect(html).toContain('/api/documents/doc?version=v#t=12.3');
  expect(html).toContain('0:12');
  expect(html).toContain('0:12.3–0:13');
  expect(html).toContain('controls');
  expect(html).toMatch(/<video[^>]+src="[^"]*\/media\/clip\?version=v[^"]*"/);
  expect(html).not.toMatch(/<video[^>]+#t=12.3/);
});
it('plays prepared audio rather than seeking into a different source container', () => {
  const html = renderToStaticMarkup(
    <MediaPreview
      document="doc"
      version="v"
      media={{ kind: 'audio', asset: 'wav-segment', startMs: 90000, endMs: 100000 }}
    />,
  );
  expect(html).toContain('<audio');
  expect(html).toContain('#t=90');
  expect(html).toContain('1:30–1:40');
  expect(html).toMatch(/<audio[^>]+src="[^"]*\/media\/wav-segment\?version=v[^"]*"/);
  expect(html).not.toMatch(/<audio[^>]+#t=90/);
  expect(html).toContain('segment of the original recording');
  expect(html).not.toContain('<img');
});
