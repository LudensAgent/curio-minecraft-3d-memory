/**
 * Deterministic least-recently-used order over section keys (phase 5D2).
 *
 * This is *runtime cache metadata* for the working-set manager: it decides which
 * resident section to evict first, and nothing else. It is never persisted, never
 * substitutes for `observedAt` / `sequence` / `Section.revision` / `saveRevision` /
 * save batches, and cache access here never refreshes evidence time.
 *
 * The order is deliberately simple: a `Map` preserves insertion order, so
 * "most recently used" is the last key and "least recently used" is the first.
 * `touch` moves an existing key to the MRU end; `insert` places a new key at the
 * MRU end (a fresh section always has a deterministic initial position); `remove`
 * drops a key (e.g. after unload). There is no predictive prefetch, no frequency
 * counting, and no per-key timestamp — only a stable total order.
 */
export class LruOrder {
  private readonly order = new Map<string, string>();

  /** Move an existing key to the MRU end. Unknown keys are ignored (use `insert`). */
  touch(key: string): void {
    if (!this.order.delete(key)) return;
    this.order.set(key, key);
  }

  /** Insert (or move) a key to the MRU end — the deterministic initial position. */
  insert(key: string): void {
    this.order.delete(key);
    this.order.set(key, key);
  }

  /** Remove a key from the order (no-op when absent). */
  remove(key: string): void {
    this.order.delete(key);
  }

  has(key: string): boolean {
    return this.order.has(key);
  }

  get size(): number {
    return this.order.size;
  }

  /** The keys in least-recently-used-first order (MRU at the end). */
  oldestFirst(): string[] {
    return [...this.order.keys()];
  }
}
