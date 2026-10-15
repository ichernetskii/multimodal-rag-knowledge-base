import { decodeVector } from './vector-codec.js';
/** A bounded LRU. It holds immutable index bytes, never authorization decisions or answers. */
export class VectorCache {
  private items = new Map<string, Float32Array>();
  private used = 0;
  constructor(private readonly limit = 32 * 1024 * 1024) {}
  get(id: string, bytes: Uint8Array) {
    const known = this.items.get(id);
    if (known) {
      this.items.delete(id);
      this.items.set(id, known);
      return known;
    }
    const value = decodeVector(bytes);
    while (this.used + value.byteLength > this.limit && this.items.size) {
      const first = this.items.keys().next().value!;
      this.used -= this.items.get(first)!.byteLength;
      this.items.delete(first);
    }
    if (value.byteLength <= this.limit) {
      this.items.set(id, value);
      this.used += value.byteLength;
    }
    return value;
  }
  clear() {
    this.items.clear();
    this.used = 0;
  }
  get stats() {
    return { entries: this.items.size, bytes: this.used, limitBytes: this.limit };
  }
}
