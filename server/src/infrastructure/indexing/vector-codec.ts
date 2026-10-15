import type { Vector } from '../../application/ports/embedding.js';
import { requireValue } from '../../shared/errors.js';
/** Portable little-endian Float32 vectors; normalization is done once at ingestion. */
export function encodeVector(vector: Vector): Uint8Array {
  const norm = Math.hypot(...vector);
  requireValue(
    vector.length > 0 && Number.isFinite(norm) && norm > 0 && vector.every(Number.isFinite),
    'INVALID_VECTOR',
    'Некорректный embedding.',
  );
  const bytes = Buffer.allocUnsafe(vector.length * 4);
  vector.forEach((value, index) => bytes.writeFloatLE(value / norm, index * 4));
  return bytes;
}
export function decodeVector(bytes: Uint8Array): Float32Array {
  requireValue(
    bytes.byteLength > 0 && bytes.byteLength % 4 === 0,
    'INDEX_INCOMPATIBLE',
    'Повреждён embedding фрагмента.',
    409,
  );
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    vector = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < vector.length; index++) {
    const value = buffer.readFloatLE(index * 4);
    requireValue(Number.isFinite(value), 'INDEX_INCOMPATIBLE', 'Некорректный embedding.', 409);
    vector[index] = value;
  }
  return vector;
}
export function dot(vector: Float32Array, question: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * question[i]!;
  return sum;
}
