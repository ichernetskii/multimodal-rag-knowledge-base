import { serverPath } from '../../config/paths.js';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page, Settings } from '../../contracts/public.js';
import { requireValue } from '../../shared/errors.js';
import { mediaKind } from '../../shared/media-types.js';
import { mediaCommand, mediaProcess } from './media-process.js';
import { extract } from './extract.js';
import { pythonCommand } from './health.js';
export interface PreparedAsset {
  id: string;
  bytes: Uint8Array;
  mime: string;
  name: string;
}
export type ProcessingSettings = Settings & { dataDir: string; whisperModel: string };
export async function prepareMaterial(
  name: string,
  bytes: Uint8Array,
  settings: ProcessingSettings,
  signal: AbortSignal,
  onOCR: () => void,
): Promise<{ pages: Page[]; assets: PreparedAsset[] }> {
  const kind = mediaKind(name),
    directory = await mkdtemp(join(settings.dataDir, 'material-'));
  const assets: PreparedAsset[] = [];
  try {
    const input = join(directory, 'input' + extname(name).toLowerCase());
    await writeFile(input, bytes, { mode: 0o600 });
    const add = async (path: string, mime: string) => {
      const data = await readFile(path);
      requireValue(
        data.length > 0 && data.length <= 20 * 1024 * 1024,
        'MEDIA_ASSET_LIMIT',
        'Prepared media is too large.',
      );
      const id = randomUUID();
      assets.push({ id, bytes: data, mime, name: path.split('/').at(-1)! });
      return id;
    };
    if (!kind) {
      const pages = await extract(name, bytes, settings, signal, onOCR);
      if (extname(name).toLowerCase() === '.pdf') {
        await mediaProcess(
          pythonCommand(),
          [
            serverPath('resources/extraction/render-pdf.py'),
            input,
            directory,
            String(settings.maxPages),
            String(settings.mediaImageMaxSide),
          ],
          signal,
          10000,
        );
        const images = (await readdir(directory))
          .filter((f) => /^page-\d+\.jpg$/u.test(f))
          .sort((a, b) => Number(a.match(/\d+/u)?.[0]) - Number(b.match(/\d+/u)?.[0]));
        for (const [i, path] of images.entries()) {
          const asset = await add(join(directory, path), 'image/jpeg');
          const page = pages[i];
          if (page) page.media = { kind: 'image', asset };
        }
      }
      return { pages, assets };
    }
    const timed = AbortSignal.any([
      signal,
      AbortSignal.timeout(settings.mediaTimeoutSeconds * 1000),
    ]);
    const info = JSON.parse(
      await mediaProcess(
        mediaCommand('ffprobe'),
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-show_format',
          '-show_streams',
          '-of',
          'json',
          input,
        ],
        timed,
      ),
    ) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; width?: number; height?: number }[];
    };
    const duration = Number(info.format?.duration ?? 0),
      video = info.streams?.find((s) => s.codec_type === 'video'),
      audio = info.streams?.some((s) => s.codec_type === 'audio');
    requireValue(
      kind === 'image' ||
        (Number.isFinite(duration) && duration > 0 && duration <= settings.mediaMaxSeconds),
      'MEDIA_DURATION_LIMIT',
      'Recording exceeds the configured duration.',
    );
    if (kind !== 'audio')
      requireValue(
        video && (video.width ?? 0) * (video.height ?? 0) <= 40_000_000,
        'INVALID_MEDIA',
        'Missing video/image stream or image exceeds 40 megapixels.',
      );
    const pages: Page[] = [];
    if (kind === 'image') {
      const path = join(directory, 'image.jpg');
      await mediaProcess(
        mediaCommand('ffmpeg'),
        [
          '-v',
          'error',
          '-nostdin',
          '-threads',
          '1',
          '-protocol_whitelist',
          'file,pipe',
          '-i',
          input,
          '-frames:v',
          '1',
          '-vf',
          `scale=${settings.mediaImageMaxSide}:${settings.mediaImageMaxSide}:force_original_aspect_ratio=decrease`,
          '-threads',
          '1',
          '-q:v',
          '3',
          '-y',
          path,
        ],
        timed,
      );
      const asset = await add(path, 'image/jpeg');
      pages.push({
        number: 1,
        text: name,
        method: 'vision',
        warnings: ['VISUAL_SOURCE_REVIEW_REQUIRED'],
        media: { kind: 'image', asset },
        sections: [],
      });
    }
    if (kind === 'video') {
      const segmentSeconds = Math.max(
        1,
        Math.min(30, Math.ceil(duration / settings.videoMaxFrames)),
      );
      requireValue(
        Math.ceil(duration / segmentSeconds) <= settings.maxPages,
        'PAGE_LIMIT',
        'Too many video segments.',
      );
      for (let start = 0; start < duration; start += segmentSeconds) {
        timed.throwIfAborted();
        const length = Math.min(segmentSeconds, duration - start),
          path = join(directory, `video-${start}.mp4`),
          preview = join(directory, `preview-${start}.jpg`);
        await mediaProcess(
          mediaCommand('ffmpeg'),
          [
            '-v',
            'error',
            '-nostdin',
            '-threads',
            '1',
            '-protocol_whitelist',
            'file,pipe',
            '-ss',
            String(start),
            '-i',
            input,
            '-t',
            String(length),
            '-an',
            '-vf',
            // Keep a frame in a sub-second tail; an empty clip cannot produce a preview.
            'fps=1:eof_action=pass,scale=768:768:force_original_aspect_ratio=decrease:force_divisible_by=2',
            '-c:v',
            'libx264',
            '-threads',
            '1',
            '-preset',
            'veryfast',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
            '-y',
            path,
          ],
          timed,
        );
        await mediaProcess(
          mediaCommand('ffmpeg'),
          [
            '-v',
            'error',
            '-nostdin',
            '-threads',
            '1',
            '-i',
            path,
            '-frames:v',
            '1',
            '-q:v',
            '3',
            '-y',
            preview,
          ],
          timed,
        );
        const asset = await add(path, 'video/mp4'),
          thumb = await add(preview, 'image/jpeg');
        pages.push({
          number: pages.length + 1,
          text: `${name}: video ${start}–${Math.ceil(start + length)} s`,
          method: 'vision',
          warnings: ['SAMPLED_VIDEO_REVIEW_REQUIRED'],
          media: {
            kind: 'video',
            asset,
            preview: thumb,
            startMs: Math.round(start * 1000),
            endMs: Math.round((start + length) * 1000),
          },
          sections: [],
        });
      }
    }
    if (kind !== 'image' && audio) {
      for (let start = 0; start < duration; start += 60) {
        const length = Math.min(60, duration - start),
          path = join(directory, `audio-${start}.wav`);
        await mediaProcess(
          mediaCommand('ffmpeg'),
          [
            '-v',
            'error',
            '-nostdin',
            '-threads',
            '1',
            '-protocol_whitelist',
            'file,pipe',
            '-ss',
            String(start),
            '-i',
            input,
            '-t',
            String(length),
            '-map',
            '0:a:0',
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-c:a',
            'pcm_s16le',
            '-threads',
            '1',
            '-y',
            path,
          ],
          timed,
        );
        const asset = await add(path, 'audio/wav');
        pages.push({
          number: pages.length + 1,
          text: `${name}: audio ${start}–${Math.ceil(start + length)} s`,
          method: 'speech',
          warnings: ['AUDIO_SOURCE_REVIEW_REQUIRED'],
          media: {
            kind: 'audio',
            asset,
            startMs: start * 1000,
            endMs: Math.round((start + length) * 1000),
          },
          sections: [],
        });
      }
    }
    requireValue(pages.length, 'INVALID_MEDIA', 'No usable media streams.');
    return { pages, assets };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
