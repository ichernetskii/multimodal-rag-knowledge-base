interface Candidate {
  id: string;
  document: string;
  version: string;
  similarity: number;
}
/** Keep only the best semantic candidates; memory and sorting cost do not grow with corpus size. */
const strength = (a: Candidate, b: Candidate) =>
  a.similarity - b.similarity || b.id.localeCompare(a.id);
export class CandidateHeap {
  private values: Candidate[] = [];
  constructor(private readonly limit: number) {}
  add(value: Candidate) {
    if (this.values.length < this.limit) {
      this.values.push(value);
      this.up(this.values.length - 1);
    } else if (strength(value, this.values[0]!) > 0) {
      this.values[0] = value;
      this.down(0);
    }
  }
  private up(index: number) {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (strength(this.values[parent]!, this.values[index]!) <= 0) break;
      [this.values[parent], this.values[index]] = [this.values[index]!, this.values[parent]!];
      index = parent;
    }
  }
  private down(index: number) {
    for (;;) {
      const left = index * 2 + 1,
        right = left + 1;
      let next = index;
      if (left < this.values.length && strength(this.values[left]!, this.values[next]!) < 0)
        next = left;
      if (right < this.values.length && strength(this.values[right]!, this.values[next]!) < 0)
        next = right;
      if (next === index) break;
      [this.values[next], this.values[index]] = [this.values[index]!, this.values[next]!];
      index = next;
    }
  }
  sorted() {
    return [...this.values].sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
  }
}
