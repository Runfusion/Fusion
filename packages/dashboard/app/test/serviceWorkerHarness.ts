import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, vi } from "vitest";

/*
FNXC:PWAOffline 2026-09-18-00:20:
Extracted from app/__tests__/pwa.test.ts so the FN-516 chain proof can drive the REAL public/sw.js
alongside the real versionCheck/swUpdate callers instead of a second, divergent copy of the harness.
Behavior is unchanged for the existing PWA suite; the only additions are (a) a settable network
responder so a chain test can move the served version from B to C, and (b) `browserFetch()`, which
models what the browser actually does when the worker declines to call respondWith(): it performs the
request itself. The previous `handleFetch()` returned `undefined` there, which a chain test would have
had to interpret — and interpreting it as "success" would have manufactured evidence.
*/

export type FakeResponse = {
  ok: boolean;
  body: string;
  clone: () => FakeResponse;
  headers?: { get: (name: string) => string | null };
};

export function makeResponse(body: string, ok = true): FakeResponse {
  const response: FakeResponse = { ok, body, clone: () => response };
  return response;
}

/*
FNXC:PWAOffline 2026-07-26-15:40:
A cache entry written by a PREVIOUS service-worker session has no in-memory put timestamp, so the SW
falls back to the response's `Date` header to prove its age. This models that entry shape.
*/
export function makeDatedResponse(body: string, dateHeaderValue: string | null): FakeResponse {
  const response: FakeResponse = {
    ok: true,
    body,
    clone: () => response,
    headers: { get: (name: string) => (name.toLowerCase() === "date" ? dateHeaderValue : null) },
  };
  return response;
}

export type FakeRequest = {
  url: string;
  method: string;
  mode?: string;
  destination?: string;
  headers: { get: (name: string) => string | null };
};

export function makeRequest(
  url: string,
  init: { mode?: string; destination?: string; accept?: string } = {},
): FakeRequest {
  return {
    url,
    method: "GET",
    mode: init.mode ?? "no-cors",
    destination: init.destination ?? "",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "accept" ? (init.accept ?? null) : null,
    },
  };
}

export type ServiceWorkerHarnessOptions = {
  /** Network responder. Defaults to a `network:<url>` echo, matching the historical harness. */
  respond?: (request: FakeRequest) => FakeResponse | Promise<FakeResponse>;
};

/*
FNXC:PWAOffline 2026-07-26-14:05:
`store` is a Map, whose iteration order is insertion order — the same ordering guarantee the Cache API
gives `cache.keys()` and which the SW's eviction relies on. Passing an existing store into a second
loadServiceWorker() call models a service worker that was terminated and restarted between builds,
which is the realistic shape of "successive rebuilds against one persistent origin cache".
*/
export function loadServiceWorker(
  existingStore?: Map<string, FakeResponse>,
  options: ServiceWorkerHarnessOptions = {},
) {
  const source = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");
  const store = existingStore ?? new Map<string, FakeResponse>();
  let respond = options.respond ?? ((request: FakeRequest) => makeResponse(`network:${request.url}`));
  const fetchMock = vi.fn(async (request: FakeRequest) => respond(request));

  /** Change what the simulated network serves (e.g. deploy build C mid-test). */
  function setNetworkResponder(next: (request: FakeRequest) => FakeResponse | Promise<FakeResponse>): void {
    respond = next;
  }

  const cache = {
    match: async (request: FakeRequest) => store.get(request.url),
    put: async (request: FakeRequest, response: FakeResponse) => {
      store.set(request.url, response);
    },
    addAll: async () => undefined,
    keys: async () => [...store.keys()].map((url) => ({ url })),
    delete: async (request: { url: string }) => store.delete(request.url),
  };
  /*
  FNXC:PWAOffline 2026-07-26-18:05:
  `keys()`/`delete()` used to be inert stubs, which made a whole-bucket purge untestable. They now model
  one real bucket named after the CACHE_NAME the source declares, so `activate`'s cross-generation
  cleanup still sees only the current generation (nothing to delete) while a PURGE_CACHES message can be
  observed actually emptying the store.
  */
  const cacheName = /const CACHE_NAME = "([^"]+)"/.exec(source)?.[1] ?? "fusion-cache";
  const caches = {
    open: async () => cache,
    match: async (request: FakeRequest) => store.get(request.url),
    keys: async () => [cacheName],
    delete: async (key: string) => {
      if (key !== cacheName) {
        return false;
      }
      store.clear();
      return true;
    },
  };

  /*
  FNXC:PWAOffline 2026-07-26-15:40:
  The /api/ fallback is bounded by AGE, so the test needs to move time without waiting. The SW reads
  the clock only through `Date.now()`/`Date.parse()`, so a stub Date on the vm global is the narrowest
  seam that can express "this entry is six minutes old" — no fake timers, no sleeps, no real elapsed
  time anywhere in the suite.
  */
  const clock = { now: Date.UTC(2026, 6, 26, 12, 0, 0) };
  const DateStub = Object.assign(
    function DateStub(this: unknown, ...args: unknown[]) {
      return new (Date as unknown as new (...a: unknown[]) => Date)(...args);
    },
    { now: () => clock.now, parse: Date.parse, UTC: Date.UTC },
  );

  const listeners = new Map<string, (event: unknown) => void>();
  const sandbox = {
    Date: DateStub,
    /*
    FNXC:PWAOffline 2026-07-26-18:05:
    Real `Response`/`Headers` so the durable put-time stamp (SW_CACHED_AT_HEADER) can be exercised end
    to end. Safe for every other test: the lightweight FakeResponse carries no `status`, so
    buildStampedResponse bails and the plain-clone path those tests assert on is unchanged.
    */
    Response,
    Headers,
    self: {
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners.set(type, handler);
      },
      skipWaiting: async () => undefined,
      clients: { claim: async () => undefined },
    },
    caches,
    fetch: fetchMock,
    console,
    URL,
  };

  runInNewContext(source, sandbox);

  async function handleFetch(request: FakeRequest): Promise<FakeResponse | undefined> {
    const fetchListener = listeners.get("fetch");
    expect(fetchListener).toBeTypeOf("function");

    let responded: Promise<FakeResponse> | undefined;
    fetchListener!({
      request,
      respondWith: (value: Promise<FakeResponse>) => {
        responded = value;
      },
      waitUntil: () => undefined,
    });

    return responded ? await responded : undefined;
  }

  /*
  FNXC:PWAOffline 2026-09-18-00:20:
  What the BROWSER does with this request, not merely what the worker chose to answer. When the worker
  declines respondWith() the browser performs the request directly, so the caller still receives a real
  network response. A chain test must observe that, otherwise "worker returned undefined" is
  indistinguishable from "worker served a cached body".
  */
  async function browserFetch(request: FakeRequest): Promise<FakeResponse> {
    const handled = await handleFetch(request);
    if (handled) return handled;
    // Same simulated network the worker uses, so `fetchMock` keeps counting every
    // request that actually reached the network, whoever issued it.
    return await fetchMock(request);
  }

  async function runActivate(): Promise<void> {
    const activateListener = listeners.get("activate");
    expect(activateListener).toBeTypeOf("function");

    let pending: Promise<unknown> | undefined;
    activateListener!({
      waitUntil: (value: Promise<unknown>) => {
        pending = value;
      },
    });

    if (pending) await pending;
  }

  async function runMessage(data: unknown): Promise<void> {
    const messageListener = listeners.get("message");
    expect(messageListener).toBeTypeOf("function");

    let pending: Promise<unknown> | undefined;
    messageListener!({
      data,
      waitUntil: (value: Promise<unknown>) => {
        pending = value;
      },
    });

    if (pending) await pending;
  }

  function advanceClock(ms: number): void {
    clock.now += ms;
  }

  return {
    handleFetch,
    browserFetch,
    runActivate,
    runMessage,
    setNetworkResponder,
    fetchMock,
    store,
    cache,
    clock,
    advanceClock,
    cacheName,
  };
}

/*
FNXC:PWAOffline 2026-07-26-14:05:
The SW schedules cache pruning fire-and-forget so it can never delay a fetch response. The prune chain
contains only already-resolved promises against the fake cache, so a single macrotask turn drains it —
no fake timers, no polling, no arbitrary sleep.
*/
export async function flushPendingPrune(): Promise<void> {
  await new Promise((done) => setTimeout(done, 0));
}
