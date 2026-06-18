// Per-key async mutex. Serializes read-modify-write sequences that share a key so
// concurrent callers can't interleave (lost updates) on the same JSON store record.
//
// Re-entrancy: this lock is NOT reentrant. A function holding the lock for a key must
// not call another function that acquires the same key, or it deadlocks. Compose by
// running locked operations sequentially (acquire/release/acquire), never nested.

const chains = new Map<string, Promise<unknown>>();

export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  // Run after the previous holder settles, regardless of its outcome.
  const run = previous.then(fn, fn);
  // The chain tail never rejects, so a failed operation doesn't poison the queue.
  const guard = run.then(() => undefined, () => undefined);
  chains.set(key, guard);
  // Drop the map entry once this is the last settled operation (bounded growth).
  void guard.then(() => {
    if (chains.get(key) === guard) chains.delete(key);
  });
  return run;
}
