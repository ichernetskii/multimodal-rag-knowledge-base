import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultWhisperModel } from '../../config/media-runtime.js';
import { mediaCommand, mediaProcess } from '../extraction/media-process.js';
import type { ModelProfile, Settings } from '../../contracts/public.js';
import { requireValue } from '../../shared/errors.js';

export async function transcribe(
  profile: ModelProfile,
  bytes: Uint8Array,
  settings: Settings,
  temp: string,
  signal: AbortSignal,
) {
  requireValue(
    profile.provider === 'whisper' && profile.model === 'small',
    'UNSUPPORTED_CAPABILITY',
    'The bundled Whisper adapter uses the verified small multilingual model.',
  );
  const model = defaultWhisperModel();
  await access(model);
  const directory = await mkdtemp(join(temp, 'speech-'));
  try {
    const input = join(directory, 'input.wav'),
      output = join(directory, 'transcript');
    await writeFile(input, bytes, { mode: 0o600 });
    await mediaProcess(
      mediaCommand('whisper'),
      [
        '-m',
        model,
        '-f',
        input,
        '-l',
        settings.whisperLanguage,
        '-t',
        String(settings.whisperThreads),
        '-otxt',
        '-of',
        output,
        '-np',
      ],
      AbortSignal.any([signal, AbortSignal.timeout(profile.timeoutMs)]),
    );
    const text = (await readFile(output + '.txt', 'utf8')).trim();
    requireValue(
      text.length <= settings.maxTextCharacters,
      'TRANSCRIPT_LIMIT',
      'Transcript is too large.',
    );
    return text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
