import { extname } from 'node:path';
const types: Record<string, [string, 'image' | 'audio' | 'video']> = {
  '.jpg': ['image/jpeg', 'image'],
  '.jpeg': ['image/jpeg', 'image'],
  '.png': ['image/png', 'image'],
  '.webp': ['image/webp', 'image'],
  '.wav': ['audio/wav', 'audio'],
  '.mp3': ['audio/mpeg', 'audio'],
  '.m4a': ['audio/mp4', 'audio'],
  '.flac': ['audio/flac', 'audio'],
  '.ogg': ['audio/ogg', 'audio'],
  '.mp4': ['video/mp4', 'video'],
  '.mov': ['video/quicktime', 'video'],
  '.webm': ['video/webm', 'video'],
  '.mkv': ['video/x-matroska', 'video'],
};
export const mediaKind = (name: string) => types[extname(name).toLowerCase()]?.[1];
export const mimeType = (name: string) =>
  types[extname(name).toLowerCase()]?.[0] ??
  (name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/plain; charset=utf-8');
export const supportedExtensions = ['.md', '.markdown', '.txt', '.pdf', ...Object.keys(types)];
