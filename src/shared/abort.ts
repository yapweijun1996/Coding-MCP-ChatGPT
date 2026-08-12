export function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : "Operation was aborted.");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

export function bindAbort(signal: AbortSignal | undefined, action: () => void | Promise<void>): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => {
    try {
      void Promise.resolve(action()).catch(() => undefined);
    } catch {
      // Cancellation cleanup is best-effort; the primary operation reports the abort.
    }
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export function signalWithTimeout(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
