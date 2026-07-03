/**
 * A tiny promise-memoizer keyed by an arbitrary value — the pure core behind the
 * worker's compiled-session reuse (issue #46).
 *
 * The browser model loader creates an ONNX `InferenceSession` with
 * `graphOptimizationLevel: "all"`, an expensive graph compile. In a batch that
 * runs many images through one persistent worker, recompiling per image is pure
 * waste — the weights and the compiled graph are identical. Memoizing the
 * `Promise<AiModel>` by content type keeps one compiled session warm for the
 * worker's lifetime and hands every subsequent image the same session.
 *
 * Why memoize the *promise* (not the resolved value): two callers that race
 * before the first load resolves must share the single in-flight load, not kick
 * off a second compile. (The batch driver is serial so this can't happen today,
 * but the property keeps the cache correct regardless of call pattern.)
 *
 * Failure eviction: a rejected load is removed so a later call can retry rather
 * than being stuck replaying the same failure forever. The `cache.get(key) === p`
 * guard makes eviction safe if the key was already replaced by a newer attempt.
 *
 * Pure and environment-free — no Worker, ONNX, or DOM access — so the reuse
 * guarantee is unit-testable under Vitest in Node.
 */
export interface SessionMemo<K, V> {
  /**
   * Return the memoized promise for `key`, or invoke `factory` to create and
   * cache it on the first call. A rejected promise is evicted so a later call
   * retries.
   */
  get(key: K, factory: () => Promise<V>): Promise<V>;
  /** Whether a (still-pending or resolved) entry exists for `key`. */
  has(key: K): boolean;
  /** Drop all entries. */
  clear(): void;
}

export function createSessionMemo<K, V>(): SessionMemo<K, V> {
  const cache = new Map<K, Promise<V>>();
  return {
    get(key, factory) {
      const hit = cache.get(key);
      if (hit) return hit;
      const p = factory();
      cache.set(key, p);
      // Evict on failure so the next call can retry a fresh load.
      p.catch(() => {
        if (cache.get(key) === p) cache.delete(key);
      });
      return p;
    },
    has(key) {
      return cache.has(key);
    },
    clear() {
      cache.clear();
    },
  };
}
