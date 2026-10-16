import { join } from 'node:path';
import { serverPath } from './paths.js';
export const mediaRuntimeDirectory = () =>
  serverPath(process.env.MEDIA_RUNTIME_DIR ?? `.cache/media/${process.platform}-${process.arch}`);
export const managedMediaCommand = (name: 'ffmpeg' | 'ffprobe' | 'whisper') =>
  join(mediaRuntimeDirectory(), 'bin', name === 'whisper' ? 'whisper-cli' : name);
export const defaultWhisperModel = () => serverPath('.cache/whisper/ggml-small.bin');
