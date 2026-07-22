// In-flight request deduplication with redirect-on-forceFresh.
//
// Basic case: when N components mount and each calls the same fetcher, the
// "check cache → fetch → store on completion" pattern fires N concurrent
// requests because every caller sees an empty cache. Routing those callers
// through this helper collapses the burst into a single network request.
//
// forceFresh case: a caller that has just committed a mutation passes
// `forceFresh: true` so it doesn't join a pre-mutation in-flight request and
// return stale data. The OLD callers that already joined the in-flight
// request are ALSO redirected — they receive the fresh response from the new
// fetch, not the stale one. This is implemented by decoupling the external
// promise that callers await from the inner fetch promise: a forceFresh
// invocation discards the old inner fetch's eventual resolution and assigns
// the new inner fetch's resolution to the SAME external promise that old
// callers are waiting on. No caller ever observes pre-mutation data once a
// post-mutation forceFresh has been requested.
//
// Layered caching (e.g. usePluginUiSlots' 60s TTL) is unaffected — that runs
// at the hook layer, above this helper.

interface InFlightEntry<T> {
  /** The promise callers await. Resolves to whichever inner fetch wins. */
  external: Promise<T>;
  /** Resolves the external promise. Guarded by `done`. */
  resolve: (value: T) => void;
  /** Rejects the external promise. Guarded by `done`. */
  reject: (err: unknown) => void;
  /** Once resolved or rejected, further fetches must not write to external. */
  done: boolean;
}

const inFlight = new Map<string, InFlightEntry<unknown>>();

export interface DedupeOptions {
  /**
   * Skip joining an existing in-flight request and start a new fetch. Any
   * callers already awaiting the prior in-flight request will be redirected
   * to receive the new fetch's response instead — they will NOT see the
   * pre-forceFresh response. Use after a mutation when callers must observe
   * the post-mutation server snapshot.
   */
  forceFresh?: boolean;
}

function makeEntry<T>(): InFlightEntry<T> {
  // Manually-constructed Deferred so we can assign whichever inner fetch
  // wins to the same external promise.
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const external = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { external, resolve, reject, done: false };
}

function attachInnerToEntry<T>(entry: InFlightEntry<T>, inner: Promise<T>): void {
  inner.then(
    (value) => {
      if (entry.done) return;
      entry.done = true;
      entry.resolve(value);
    },
    (err) => {
      if (entry.done) return;
      entry.done = true;
      entry.reject(err);
    },
  );
}

export function dedupe<T>(
  key: string,
  fn: () => Promise<T>,
  options?: DedupeOptions,
): Promise<T> {
  const existing = inFlight.get(key) as InFlightEntry<T> | undefined;

  if (existing && !existing.done) {
    if (!options?.forceFresh) {
      // Standard dedupe — join the in-flight request.
      return existing.external;
    }
    // forceFresh with an existing in-flight: start a new inner fetch and
    // redirect existing.external to its result. The old inner fetch's
    // eventual resolution is discarded by the `done` guard in
    // attachInnerToEntry.
    attachInnerToEntry(existing, fn());
    return existing.external;
  }

  // No live entry (or forceFresh with nothing in flight) — start fresh.
  const entry = makeEntry<T>();
  attachInnerToEntry(entry, fn());
  // Schedule cleanup once the external promise settles. We compare by
  // identity so a later forceFresh that swaps in a new entry under the same
  // key doesn't get deleted by this old cleanup.
  void entry.external.then(
    () => {
      if (inFlight.get(key) === entry) inFlight.delete(key);
    },
    () => {
      if (inFlight.get(key) === entry) inFlight.delete(key);
    },
  );
  inFlight.set(key, entry as InFlightEntry<unknown>);
  return entry.external;
}
