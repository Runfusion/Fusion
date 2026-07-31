import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";
import {
  clearAllLocalCache,
  PURGE_CACHES_MESSAGE,
  purgeCacheStorage,
} from "../utils/swrCache";

/*
FNXC:PWAOffline 2026-07-26-10:44:
Restore latency after a mobile discard is a behavior, not a source-string shape, so it needs an executable seam. Evaluating sw.js in a fresh vm context with fake `caches`/`fetch` exercises the real fetch handler without a browser, a build step, or any timers — the cheapest harness that can prove "cache hit means zero network calls".
*/
type FakeResponse = {
  ok: boolean;
  body: string;
  clone: () => FakeResponse;
  headers?: { get: (name: string) => string | null };
};

function makeResponse(body: string, ok = true): FakeResponse {
  const response: FakeResponse = { ok, body, clone: () => response };
  return response;
}

/*
FNXC:PWAOffline 2026-07-26-15:40:
A cache entry written by a PREVIOUS service-worker session has no in-memory put timestamp, so the SW
falls back to the response's `Date` header to prove its age. This models that entry shape.
*/
function makeDatedResponse(body: string, dateHeaderValue: string | null): FakeResponse {
  const response: FakeResponse = {
    ok: true,
    body,
    clone: () => response,
    headers: { get: (name: string) => (name.toLowerCase() === "date" ? dateHeaderValue : null) },
  };
  return response;
}

type FakeRequest = {
  url: string;
  method: string;
  mode?: string;
  destination?: string;
  headers: { get: (name: string) => string | null };
};

function makeRequest(url: string, init: { mode?: string; destination?: string } = {}): FakeRequest {
  return {
    url,
    method: "GET",
    mode: init.mode ?? "no-cors",
    destination: init.destination ?? "",
    headers: { get: () => null },
  };
}

/*
FNXC:PWAOffline 2026-07-26-14:05:
`store` is a Map, whose iteration order is insertion order — the same ordering guarantee the Cache API
gives `cache.keys()` and which the SW's eviction relies on. Passing an existing store into a second
loadServiceWorker() call models a service worker that was terminated and restarted between builds,
which is the realistic shape of "successive rebuilds against one persistent origin cache".
*/
function loadServiceWorker(existingStore?: Map<string, FakeResponse>) {
  const source = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");
  const store = existingStore ?? new Map<string, FakeResponse>();
  const fetchMock = vi.fn(async (request: FakeRequest) => makeResponse(`network:${request.url}`));

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

  return { handleFetch, runActivate, runMessage, fetchMock, store, cache, clock, advanceClock, cacheName };
}

/*
FNXC:PWAOffline 2026-07-26-14:05:
The SW schedules cache pruning fire-and-forget so it can never delay a fetch response. The prune chain
contains only already-resolved promises against the fake cache, so a single macrotask turn drains it —
no fake timers, no polling, no arbitrary sleep.
*/
async function flushPendingPrune(): Promise<void> {
  await new Promise((done) => setTimeout(done, 0));
}

function buildAssetUrl(build: number, index: number): string {
  // Mimics Vite's `[name]-[hash].js`; the hash segment must satisfy HASHED_ASSET_PATTERN.
  return `https://fusion.test/assets/chunk-B${String(build).padStart(3, "0")}Z${String(index).padStart(4, "0")}.js`;
}

function countCachedAssets(store: Map<string, FakeResponse>): number {
  return [...store.keys()].filter((url) => url.includes("/assets/")).length;
}

function countCachedApiEntries(store: Map<string, FakeResponse>): number {
  return [...store.keys()].filter((url) => url.includes("/api/")).length;
}

/** Mirrors MAX_API_CACHE_ENTRIES / MAX_API_CACHE_AGE_MS in sw.js. */
const MAX_API_ENTRIES = 100;
const API_CACHE_TTL_MS = 5 * 60 * 1000;

function apiUrl(index: number): string {
  return `https://fusion.test/api/tasks/FN-${String(index).padStart(4, "0")}?project=p1`;
}

const HASHED_ASSET_URL = "https://fusion.test/assets/index-CydU98D-.js";

type DecodedPng = {
  width: number;
  height: number;
  colorType: number;
  pixels: Buffer;
};

function getStandaloneDisplayModeBlock(css: string): string {
  const match = /@media\s*\(\s*display-mode:\s*standalone\s*\)\s*\{/.exec(css);
  expect(match).toBeTruthy();

  const start = match!.index;
  const open = css.indexOf("{", start);
  let depth = 1;
  let i = open + 1;

  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }

  return css.slice(start, i);
}

function decodeRgbaPng(filePath: string): DecodedPng {
  const buffer = readFileSync(filePath);
  const signature = buffer.subarray(0, 8).toString("hex");
  expect(signature).toBe("89504e470d0a1a0a");

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  expect(bitDepth).toBe(8);
  expect(colorType).toBe(6);

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const pixels = Buffer.alloc(width * height * bytesPerPixel);
  let inputOffset = 0;
  let outputOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;

    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[inputOffset + x];
      const left = x >= bytesPerPixel ? pixels[outputOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[outputOffset + x - stride] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[outputOffset + x - stride - bytesPerPixel] : 0;
      let value: number;

      if (filter === 0) {
        value = raw;
      } else if (filter === 1) {
        value = raw + left;
      } else if (filter === 2) {
        value = raw + up;
      } else if (filter === 3) {
        value = raw + Math.floor((left + up) / 2);
      } else if (filter === 4) {
        const predictor = left + up - upLeft;
        const pa = Math.abs(predictor - left);
        const pb = Math.abs(predictor - up);
        const pc = Math.abs(predictor - upLeft);
        const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        value = raw + paeth;
      } else {
        throw new Error(`Unsupported PNG filter ${filter} in ${filePath}`);
      }

      pixels[outputOffset + x] = value & 0xff;
    }

    inputOffset += stride;
    outputOffset += stride;
  }

  return { width, height, colorType, pixels };
}

describe("PWA configuration", () => {
  it("manifest defines required PWA fields and icon sizes", () => {
    const manifestPath = resolve(__dirname, "../public/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      display?: string;
      icons?: Array<{ src?: string; sizes?: string; type?: string; purpose?: string }>;
    };

    expect(manifest.name).toBe("Fusion");
    expect(manifest.short_name).toBe("Fusion");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons).toContainEqual({
      src: "/icons/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    });
    expect(manifest.icons).toContainEqual({
      src: "/icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    });
  });

  it("index.html includes required PWA meta tags", () => {
    const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf8");

    expect(indexHtml).toContain('<link rel="manifest"');
    expect(indexHtml).toContain("apple-mobile-web-app-capable");
  });

  it("viewport meta includes viewport-fit=cover for safe-area support", () => {
    const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf8");

    expect(indexHtml).toMatch(/<meta\s+name="viewport"[^>]*content="[^"]*viewport-fit=cover[^"]*"/i);
  });

  it("viewport meta keeps mobile baseline + safe-area support", () => {
    const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf8");

    expect(indexHtml).toMatch(/<meta\s+name="viewport"[^>]*content="[^"]*width=device-width[^"]*"/i);
    expect(indexHtml).toMatch(/<meta\s+name="viewport"[^>]*content="[^"]*initial-scale=1\.0[^"]*"/i);
    expect(indexHtml).toMatch(/<meta\s+name="viewport"[^>]*content="[^"]*viewport-fit=cover[^"]*"/i);
  });

  it("CSS includes display-mode: standalone rule with a :root token override only", () => {
    const cssContent = loadAllAppCss();
    const standaloneBlock = getStandaloneDisplayModeBlock(cssContent);

    expect(standaloneBlock).toContain("@media (display-mode: standalone)");
    expect(standaloneBlock).toMatch(/:root\s*\{[\s\S]*?--standalone-bottom-gap:\s*var\(--space-sm\)/);
    expect(standaloneBlock).not.toContain("#root {");
  });

  it("CSS defines --standalone-bottom-gap token in :root", () => {
    const cssContent = loadAllAppCss();

    // Base token defaults to 0px and standalone mode overrides it via :root inside display-mode media query.
    expect(cssContent).toContain("--standalone-bottom-gap: 0px");
    expect(cssContent).toContain("--standalone-bottom-gap: var(--space-sm)");
  });

  it("CSS applies standalone bottom gap via scoped mobile layout rules, not global #root padding", () => {
    const cssContent = loadAllAppCss();

    expect(cssContent).toMatch(/\.project-content--with-mobile-nav\s*\{[^}]*var\(--standalone-bottom-gap\)/);
    expect(cssContent).toMatch(/\.executor-status-bar\s*\{[^}]*var\(--standalone-bottom-gap\)/);
    expect(cssContent).not.toMatch(/#root\s*\{[^}]*var\(--standalone-bottom-gap\)/);
  });

  it("service worker contains lifecycle handlers and versioned cache name", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain('addEventListener("install"');
    expect(swSource).toContain('addEventListener("fetch"');
    expect(swSource).toContain('addEventListener("activate"');
    expect(swSource).toContain('const CACHE_NAME = "fusion-cache-v7";');
  });

  it("service worker bypasses SSE requests instead of trying to cache them", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain('text/event-stream');
    expect(swSource).toContain('url.pathname === "/api/events"');
    expect(swSource).toContain('url.pathname.startsWith("/api/events/")');
    expect(swSource).toContain("if (isEventStreamRequest) {");
    expect(swSource).toContain("return;");
  });

  it("service worker revalidates navigation requests so index.html cannot stay stale", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain('request.mode === "navigate"');
    expect(swSource).toContain('request.destination === "document"');
    expect(swSource).toContain('url.pathname === "/index.html"');
    expect(swSource).toContain('[sw] navigation cache put failed');
  });

  it("service worker revalidates built assets so stale bundles cannot blank the app", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain('url.pathname.startsWith("/assets/")');
    expect(swSource).toContain('request.destination === "script"');
    expect(swSource).toContain('request.destination === "style"');
    expect(swSource).toContain('if (isBuiltAssetRequest) {');
    expect(swSource).toContain('[sw] asset cache put failed');
    expect(swSource).toContain('[sw] asset cache lookup failed');
  });

  it("service worker activates updated code immediately", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain("await self.skipWaiting()");
    expect(swSource).toContain("await self.clients.claim()");
  });

  describe("service worker restore strategy", () => {
    it("serves a cached content-hashed asset without any network call", async () => {
      const { handleFetch, fetchMock, store } = loadServiceWorker();
      store.set(HASHED_ASSET_URL, makeResponse("cached-entry-chunk"));

      const response = await handleFetch(makeRequest(HASHED_ASSET_URL, { destination: "script" }));

      expect(response?.body).toBe("cached-entry-chunk");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("falls through to the network for a hashed asset that is not cached, and populates the cache", async () => {
      const { handleFetch, fetchMock, store } = loadServiceWorker();

      const first = await handleFetch(makeRequest(HASHED_ASSET_URL, { destination: "script" }));
      expect(first?.body).toBe(`network:${HASHED_ASSET_URL}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(store.get(HASHED_ASSET_URL)).toBeDefined();

      const second = await handleFetch(makeRequest(HASHED_ASSET_URL, { destination: "script" }));
      expect(second?.body).toBe(`network:${HASHED_ASSET_URL}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("never pins a failed hashed-asset response into the immutable cache", async () => {
      const { handleFetch, fetchMock, store } = loadServiceWorker();
      fetchMock.mockImplementationOnce(async () => makeResponse("not-found", false));

      await handleFetch(makeRequest(HASHED_ASSET_URL, { destination: "script" }));

      expect(store.has(HASHED_ASSET_URL)).toBe(false);
    });

    it("keeps navigation network-first even when a cached shell exists", async () => {
      const { handleFetch, fetchMock, store } = loadServiceWorker();
      const shellUrl = "https://fusion.test/";
      store.set(shellUrl, makeResponse("cached-shell"));

      const response = await handleFetch(
        makeRequest(shellUrl, { mode: "navigate", destination: "document" }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response?.body).toBe(`network:${shellUrl}`);
    });

    it("keeps a non-hashed /assets/ URL on the network-first path", async () => {
      const { handleFetch, fetchMock, store } = loadServiceWorker();
      const unhashedUrl = "https://fusion.test/assets/vendor-runtime.js";
      store.set(unhashedUrl, makeResponse("cached-unhashed"));

      const response = await handleFetch(makeRequest(unhashedUrl, { destination: "script" }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response?.body).toBe(`network:${unhashedUrl}`);
    });

    it("serves preloaded fonts cache-first regardless of hashing", async () => {
      const { handleFetch, fetchMock, store } = loadServiceWorker();
      const fontUrl = "https://fusion.test/fonts/SymbolsNerdFontMono-Regular.ttf";
      store.set(fontUrl, makeResponse("cached-font"));

      const response = await handleFetch(makeRequest(fontUrl, { destination: "font" }));

      expect(response?.body).toBe("cached-font");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    /*
    FNXC:PWAOffline 2026-07-26-14:05:
    Cache-first hashed assets made cache size load-bearing while nothing evicted within a generation,
    so a self-hosted Fusion rebuilt daily accumulated every dead build's ~130 chunks forever. On iOS
    that risks the all-or-nothing per-origin quota eviction, which would take localStorage (SWR board
    snapshot, kb-dashboard-* prefs) with it. These tests pin the two halves of the bound: the cache
    stays capped across successive builds, and assets the running shell uses are never the ones evicted.
    */
    it("bounds the asset cache across successive rebuilds instead of growing forever", async () => {
      const buildSize = 130;
      const sharedStore = new Map<string, FakeResponse>();
      sharedStore.set("https://fusion.test/", makeResponse("cached-shell"));
      sharedStore.set("https://fusion.test/api/tasks", makeResponse("cached-tasks"));

      const counts: number[] = [];

      // Each build gets a fresh SW instance against the same persistent cache: a service worker is
      // terminated when idle, so successive rebuilds do not share one session's exemption set.
      for (let build = 1; build <= 3; build += 1) {
        const { handleFetch } = loadServiceWorker(sharedStore);
        for (let index = 0; index < buildSize; index += 1) {
          await handleFetch(makeRequest(buildAssetUrl(build, index), { destination: "script" }));
        }
        await flushPendingPrune();
        counts.push(countCachedAssets(sharedStore));
      }

      // Unbounded growth would be 130 / 260 / 390.
      expect(counts[0]).toBe(buildSize);
      expect(counts[1]).toBeLessThanOrEqual(200);
      expect(counts[2]).toBeLessThanOrEqual(200);

      // The newest build must be fully resident — eviction removes dead builds, not the live one.
      for (let index = 0; index < buildSize; index += 1) {
        expect(sharedStore.has(buildAssetUrl(3, index))).toBe(true);
      }

      // The oldest build is what got reclaimed.
      const survivingBuildOne = Array.from({ length: buildSize }, (_, index) =>
        sharedStore.has(buildAssetUrl(1, index)),
      ).filter(Boolean).length;
      expect(survivingBuildOne).toBeLessThan(buildSize);

      // Eviction is scoped to hashed /assets/ entries; the shell and API fallbacks are untouched.
      expect(sharedStore.has("https://fusion.test/")).toBe(true);
      expect(sharedStore.has("https://fusion.test/api/tasks")).toBe(true);
    });

    it("never evicts assets the current shell is using, even when they are the oldest entries", async () => {
      const { handleFetch, store } = loadServiceWorker();
      const shellAssets = Array.from({ length: 40 }, (_, index) => buildAssetUrl(9, index));

      // The running build's chunks are cached FIRST, so plain insertion-order eviction would take
      // them before anything else. The session-referenced exemption must override that ordering.
      for (const assetUrl of shellAssets) {
        await handleFetch(makeRequest(assetUrl, { destination: "script" }));
      }
      await flushPendingPrune();

      // A previous build's leftovers land in the cache *after* them (newer by insertion order).
      for (let index = 0; index < 200; index += 1) {
        store.set(buildAssetUrl(8, index), makeResponse("dead-build-chunk"));
      }

      // One more live request drives the cache over the cap and triggers a prune.
      await handleFetch(makeRequest(buildAssetUrl(9, 40), { destination: "script" }));
      await flushPendingPrune();

      for (const assetUrl of shellAssets) {
        expect(store.has(assetUrl)).toBe(true);
      }
      expect(store.has(buildAssetUrl(9, 40))).toBe(true);
      expect(countCachedAssets(store)).toBeLessThanOrEqual(200);
    });

    it("prunes an over-cap cache on activate, not only on the fetch cold path", async () => {
      const { runActivate, store } = loadServiceWorker();
      for (let index = 0; index < 250; index += 1) {
        store.set(buildAssetUrl(7, index), makeResponse("dead-build-chunk"));
      }

      await runActivate();

      expect(countCachedAssets(store)).toBe(200);
    });

    it("keeps serving assets when cache pruning throws", async () => {
      const { handleFetch, store, cache, fetchMock } = loadServiceWorker();
      cache.keys = async () => {
        throw new Error("quota inspection failed");
      };

      const response = await handleFetch(makeRequest(HASHED_ASSET_URL, { destination: "script" }));
      await flushPendingPrune();

      expect(response?.body).toBe(`network:${HASHED_ASSET_URL}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(store.has(HASHED_ASSET_URL)).toBe(true);
    });

    it("keeps /api/ responses network-first so cached data cannot go stale", async () => {
      const { handleFetch, fetchMock, store } = loadServiceWorker();
      const apiUrl = "https://fusion.test/api/tasks";
      store.set(apiUrl, makeResponse("cached-tasks"));

      const response = await handleFetch(makeRequest(apiUrl));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response?.body).toBe(`network:${apiUrl}`);
    });

    /*
    FNXC:PWAOffline 2026-07-26-15:40:
    The hashed-asset cap left the other unbounded writer in sw.js untouched: every GET /api/ response
    was cached and nothing evicted it. The dashboard emits an open-ended set of distinct /api/ URLs
    (per project, per task, per query string), so the API half grew forever — the same iOS
    all-or-nothing origin-quota hazard that can take localStorage down with it. These tests pin both
    halves of the bound: a count cap, and a freshness bound on the fallback so a stale response can
    never be served as if it were live.
    */
    it("bounds the /api/ cache across many distinct URLs instead of growing forever", async () => {
      const { handleFetch, store } = loadServiceWorker();
      const requestCount = 150;

      for (let index = 0; index < requestCount; index += 1) {
        await handleFetch(makeRequest(apiUrl(index)));
      }
      await flushPendingPrune();

      // Unbounded growth would be 150.
      expect(countCachedApiEntries(store)).toBeLessThanOrEqual(MAX_API_ENTRIES);

      // Eviction is oldest-first, so the most recent responses are the ones that survive.
      expect(store.has(apiUrl(requestCount - 1))).toBe(true);
      expect(store.has(apiUrl(0))).toBe(false);
    });

    it("keeps /api/ eviction from touching cached assets or the shell", async () => {
      const store = new Map<string, FakeResponse>();
      store.set("https://fusion.test/", makeResponse("cached-shell"));
      store.set(HASHED_ASSET_URL, makeResponse("cached-entry-chunk"));
      const { handleFetch } = loadServiceWorker(store);

      for (let index = 0; index < 150; index += 1) {
        await handleFetch(makeRequest(apiUrl(index)));
      }
      await flushPendingPrune();

      expect(store.has("https://fusion.test/")).toBe(true);
      expect(store.has(HASHED_ASSET_URL)).toBe(true);
    });

    it("serves a recently cached /api/ response when the network fails", async () => {
      const { handleFetch, fetchMock, advanceClock } = loadServiceWorker();
      const url = apiUrl(1);

      await handleFetch(makeRequest(url));
      fetchMock.mockImplementation(async () => {
        throw new Error("offline");
      });
      advanceClock(30_000);

      const response = await handleFetch(makeRequest(url));
      expect(response?.body).toBe(`network:${url}`);
    });

    it("refuses to serve an expired /api/ entry and evicts it instead", async () => {
      const { handleFetch, fetchMock, store, advanceClock } = loadServiceWorker();
      const url = apiUrl(2);

      await handleFetch(makeRequest(url));
      expect(store.has(url)).toBe(true);

      fetchMock.mockImplementation(async () => {
        throw new Error("offline");
      });
      advanceClock(API_CACHE_TTL_MS + 1_000);

      await expect(handleFetch(makeRequest(url))).rejects.toThrow("offline");
      expect(store.has(url)).toBe(false);
    });

    /*
    FNXC:PWAOffline 2026-07-26-15:40:
    A tab discarded by iOS restarts the service worker, so the put-time timestamps are gone while the
    cache entries persist. Age must then be provable from the response's `Date` header (Fusion serves
    its API from Node, which always sets it), and an entry whose age cannot be proven at all must
    fail closed rather than be served.
    */
    it("honours the freshness bound from the Date header after a service-worker restart", async () => {
      const store = new Map<string, FakeResponse>();
      const freshUrl = apiUrl(3);
      const staleUrl = apiUrl(4);
      const { handleFetch, fetchMock, clock } = loadServiceWorker(store);
      store.set(freshUrl, makeDatedResponse("previous-session-fresh", new Date(clock.now - 60_000).toUTCString()));
      store.set(
        staleUrl,
        makeDatedResponse("previous-session-stale", new Date(clock.now - API_CACHE_TTL_MS - 60_000).toUTCString()),
      );
      fetchMock.mockImplementation(async () => {
        throw new Error("offline");
      });

      const fresh = await handleFetch(makeRequest(freshUrl));
      expect(fresh?.body).toBe("previous-session-fresh");

      await expect(handleFetch(makeRequest(staleUrl))).rejects.toThrow("offline");
      expect(store.has(staleUrl)).toBe(false);
    });

    it("fails closed for an /api/ entry whose age cannot be proven", async () => {
      const store = new Map<string, FakeResponse>();
      const url = apiUrl(5);
      store.set(url, makeResponse("age-unknown"));
      const { handleFetch, fetchMock } = loadServiceWorker(store);
      fetchMock.mockImplementation(async () => {
        throw new Error("offline");
      });

      await expect(handleFetch(makeRequest(url))).rejects.toThrow("offline");
      expect(store.has(url)).toBe(false);
    });

    it("keeps serving /api/ requests when cache pruning throws", async () => {
      const { handleFetch, cache, store } = loadServiceWorker();
      cache.keys = async () => {
        throw new Error("quota inspection failed");
      };

      for (let index = 0; index < 15; index += 1) {
        const response = await handleFetch(makeRequest(apiUrl(index)));
        expect(response?.body).toBe(`network:${apiUrl(index)}`);
      }
      await flushPendingPrune();

      expect(store.has(apiUrl(14))).toBe(true);
    });

    /*
    FNXC:PWAOffline 2026-07-26-18:05:
    Every successful GET /api/* response used to be written to durable Cache Storage. GET /api/settings
    and /api/settings/global return plaintext `daemonToken`, `githubAuthToken`, `gitlabAuthToken`, and
    `ntfyAccessToken`, so dashboard credentials were persisted on the origin and survived logout, token
    rotation, and project switch. The entry cap and TTL added earlier bound size and staleness; neither
    is a confidentiality control.

    These tests assert the INVARIANT ("a non-allow-listed /api/ URL is never written to and never read
    from the cache") across every credential-bearing surface named in the review plus the token-in-URL
    shape, not just the single reported endpoint — an allow-list regressed back to a deny-list would
    still pass a one-endpoint test.
    */
    const CREDENTIAL_BEARING_API_URLS = [
      "https://fusion.test/api/settings",
      "https://fusion.test/api/settings/global",
      "https://fusion.test/api/settings/export",
      "https://fusion.test/api/settings/auth-export",
      "https://fusion.test/api/secrets",
      "https://fusion.test/api/secrets/list?projectId=p1",
      "https://fusion.test/api/auth/providers/anthropic/login?state=xyz",
      "https://fusion.test/api/agents",
      "https://fusion.test/api/git/status?projectId=p1",
      "https://fusion.test/api/chat/sessions",
      // Allow-listed PREFIX, non-allow-listed depth: attachments carry the bearer token in the URL.
      "https://fusion.test/api/tasks/FN-0001/attachments/screenshot.png?fn_token=daemon-token",
      "https://fusion.test/api/artifacts/art-1/media?fn_token=daemon-token",
      // Allow-listed path that nonetheless carries a token query param.
      "https://fusion.test/api/tasks?projectId=p1&fn_token=daemon-token",
    ];

    it.each(CREDENTIAL_BEARING_API_URLS)("never writes %s to the cache", async (url) => {
      const { handleFetch, store } = loadServiceWorker();

      await handleFetch(makeRequest(url));
      await flushPendingPrune();

      expect(store.has(url)).toBe(false);
      expect(store.size).toBe(0);
    });

    it.each(CREDENTIAL_BEARING_API_URLS)(
      "never serves %s from a cache entry an older worker left behind",
      async (url) => {
        const store = new Map<string, FakeResponse>();
        store.set(url, makeResponse('{"daemonToken":"leaked"}'));
        const { handleFetch, fetchMock } = loadServiceWorker(store);
        fetchMock.mockImplementation(async () => {
          throw new Error("offline");
        });

        // The service worker declines to handle the request at all, so the browser performs it
        // directly and the leftover entry is never read.
        await expect(handleFetch(makeRequest(url))).resolves.toBeUndefined();
      },
    );

    it("never caches a failed /api/ response as an offline fallback", async () => {
      const { handleFetch, fetchMock, store } = loadServiceWorker();
      const url = "https://fusion.test/api/tasks?projectId=p1";
      // A 401 right after a token rotation, or a 500 from a restarting daemon.
      fetchMock.mockImplementation(async () => makeResponse('{"error":"unauthorized"}', false));

      const response = await handleFetch(makeRequest(url));

      expect(response?.body).toBe('{"error":"unauthorized"}');
      expect(store.has(url)).toBe(false);
    });

    it("still caches the allow-listed board reads the mobile restore path depends on", async () => {
      const { handleFetch, store } = loadServiceWorker();
      const allowed = [
        "https://fusion.test/api/tasks?projectId=p1",
        "https://fusion.test/api/tasks/FN-0042",
        "https://fusion.test/api/projects",
      ];

      for (const url of allowed) {
        const response = await handleFetch(makeRequest(url));
        expect(response?.body).toBe(`network:${url}`);
      }

      for (const url of allowed) {
        expect(store.has(url)).toBe(true);
      }
    });

    /*
    FNXC:PWAOffline 2026-07-26-18:05:
    The operator's "Clear all cached data" affordance walked localStorage only; nothing in the app
    touched the caches API, so every cached response — credentials included — survived it. The purge now
    routes through the service worker because the caller reloads immediately, which can abort an in-page
    delete; the worker is not torn down by that reload.
    */
    it("purges Cache Storage on a PURGE_CACHES message", async () => {
      const { runMessage, store } = loadServiceWorker();
      store.set(HASHED_ASSET_URL, makeResponse("cached-entry-chunk"));
      store.set("https://fusion.test/api/tasks", makeResponse("cached-tasks"));
      store.set("https://fusion.test/", makeResponse("cached-shell"));

      await runMessage({ type: "PURGE_CACHES" });

      expect(store.size).toBe(0);
    });

    it("ignores unrelated service-worker messages instead of purging", async () => {
      const { runMessage, store } = loadServiceWorker();
      store.set(HASHED_ASSET_URL, makeResponse("cached-entry-chunk"));

      await runMessage({ type: "SKIP_WAITING" });

      expect(store.size).toBe(1);
    });

    /*
    FNXC:PWAOffline 2026-07-26-18:05:
    Browsers idle-terminate a service worker after ~30s with no events — the normal state of the
    BACKGROUNDED tab this whole feature targets. The next wake is a cold start whose `apiCacheTimestamps`
    and `sessionReferencedAssets` are EMPTY, so a prune then has no put-time record and no pin set. It
    must still bound the cache rather than throw, no-op, or evict everything.
    */
    it("prunes correctly on a cold start with no in-memory timestamps or pins", async () => {
      const store = new Map<string, FakeResponse>();
      for (let index = 0; index < 250; index += 1) {
        store.set(buildAssetUrl(4, index), makeResponse("previous-session-chunk"));
      }
      for (let index = 0; index < 250; index += 1) {
        store.set(apiUrl(index), makeResponse("previous-session-api"));
      }
      store.set("https://fusion.test/", makeResponse("cached-shell"));

      const { runActivate } = loadServiceWorker(store);
      await runActivate();

      expect(countCachedAssets(store)).toBe(200);
      expect(countCachedApiEntries(store)).toBe(MAX_API_ENTRIES);
      // Oldest-first: the newest entries of each class are the survivors.
      expect(store.has(buildAssetUrl(4, 249))).toBe(true);
      expect(store.has(apiUrl(249))).toBe(true);
      expect(store.has(buildAssetUrl(4, 0))).toBe(false);
      expect(store.has(apiUrl(0))).toBe(false);
      // Unowned entries stay put.
      expect(store.has("https://fusion.test/")).toBe(true);
    });

    /*
    FNXC:PWAOffline 2026-07-26-18:05:
    Freshness must survive that same cold start. The put-time stamp written into the stored response is
    the only age proof here — the fake network response carries no `Date` header — so this proves the
    durable header, not the in-memory map.
    */
    it("proves /api/ entry age from the durable put-time stamp after a worker restart", async () => {
      const store = new Map<string, FakeResponse>();
      const url = "https://fusion.test/api/tasks?projectId=p1";

      const first = loadServiceWorker(store);
      first.fetchMock.mockImplementation(
        async () => new Response("live-tasks", { status: 200 }) as unknown as FakeResponse,
      );
      await first.handleFetch(makeRequest(url));
      expect(store.has(url)).toBe(true);

      // Cold start: a brand-new worker instance over the same persistent cache, with empty maps.
      const restarted = loadServiceWorker(store);
      restarted.fetchMock.mockImplementation(async () => {
        throw new Error("offline");
      });
      restarted.advanceClock(60_000);

      const served = (await restarted.handleFetch(makeRequest(url))) as unknown as Response;
      expect(await served.text()).toBe("live-tasks");

      // Past the freshness bound the same cold-started worker must refuse and evict it.
      const expired = loadServiceWorker(store);
      expired.fetchMock.mockImplementation(async () => {
        throw new Error("offline");
      });
      expired.advanceClock(API_CACHE_TTL_MS + 1_000);

      await expect(expired.handleFetch(makeRequest(url))).rejects.toThrow("offline");
      expect(store.has(url)).toBe(false);
    });
  });

  /*
  FNXC:PWAOffline 2026-07-26-18:05:
  Settings -> "Clear all cached data" is the operator's only purge affordance, and it reached
  localStorage ONLY — nothing in the dashboard touched the caches API, so every service-worker-cached
  response (credentials included, before the sw.js allow-list) survived it intact. These tests pin that
  the purge now reaches Cache Storage through both paths: the service-worker message (which survives the
  immediate reload the click handler performs) and the direct in-page walk (which covers a page no
  worker controls).
  */
  describe("operator cache purge", () => {
    const originalCaches = (globalThis as { caches?: unknown }).caches;
    const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

    function installFakeCacheStorage(bucketNames: string[]) {
      const buckets = new Set(bucketNames);
      const fake = {
        keys: vi.fn(async () => [...buckets]),
        delete: vi.fn(async (key: string) => buckets.delete(key)),
        open: vi.fn(),
        match: vi.fn(),
        has: vi.fn(),
      };
      Object.defineProperty(globalThis, "caches", { value: fake, configurable: true, writable: true });
      return { fake, buckets };
    }

    function installController(): { postMessage: ReturnType<typeof vi.fn> } | null {
      const controller = { postMessage: vi.fn() };
      Object.defineProperty(navigator, "serviceWorker", {
        value: { controller },
        configurable: true,
      });
      return controller;
    }

    afterEach(() => {
      Object.defineProperty(globalThis, "caches", {
        value: originalCaches,
        configurable: true,
        writable: true,
      });
      if (originalServiceWorker) {
        Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
      } else {
        delete (navigator as unknown as Record<string, unknown>).serviceWorker;
      }
      localStorage.clear();
      vi.restoreAllMocks();
    });

    it("purgeCacheStorage deletes every cache bucket on the origin", async () => {
      const { fake, buckets } = installFakeCacheStorage(["fusion-cache-v7", "fusion-cache-v6"]);

      const deleted = await purgeCacheStorage();

      expect(deleted).toBe(2);
      expect(buckets.size).toBe(0);
      expect(fake.delete).toHaveBeenCalledWith("fusion-cache-v7");
      expect(fake.delete).toHaveBeenCalledWith("fusion-cache-v6");
    });

    it("purgeCacheStorage is a no-op when Cache Storage is unavailable", async () => {
      Object.defineProperty(globalThis, "caches", { value: undefined, configurable: true, writable: true });

      await expect(purgeCacheStorage()).resolves.toBe(0);
    });

    it("clearAllLocalCache asks the controlling worker to purge and clears localStorage", async () => {
      installFakeCacheStorage(["fusion-cache-v7"]);
      const controller = installController();
      localStorage.setItem("kb-dashboard-tasks-cache:p1", "{}");
      localStorage.setItem("fn.authToken", "keep-me");

      const removed = clearAllLocalCache();

      expect(removed).toBeGreaterThan(0);
      expect(localStorage.getItem("kb-dashboard-tasks-cache:p1")).toBeNull();
      expect(localStorage.getItem("fn.authToken")).toBe("keep-me");
      expect(controller?.postMessage).toHaveBeenCalledWith({ type: PURGE_CACHES_MESSAGE });
    });

    it("clearAllLocalCache still purges Cache Storage directly when no worker controls the page", async () => {
      const { buckets } = installFakeCacheStorage(["fusion-cache-v7"]);
      Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true });
      localStorage.setItem("kb-dashboard-projects-cache", "{}");

      clearAllLocalCache();
      // The direct purge is fire-and-forget; drain the microtask/macrotask chain it queued.
      await flushPendingPrune();

      expect(buckets.size).toBe(0);
    });
  });

  describe("logo assets", () => {
    it("logo.svg uses ring + swoosh geometry matching Header.tsx brand mark", () => {
      const logoSvg = readFileSync(resolve(__dirname, "../public/logo.svg"), "utf8");

      // Must contain the outer ring (circle with r=52, matching Header.tsx header-logo)
      expect(logoSvg).toContain('cx="64"');
      expect(logoSvg).toContain('cy="64"');
      expect(logoSvg).toContain('r="52"');
      expect(logoSvg).toContain('stroke-width="8"');

      // Must contain the swoosh/comet path shape (d attribute from Header.tsx)
      // The path starts with M26 101C... and creates the comet-like swoosh
      expect(logoSvg).toContain('d="M26 101');
      expect(logoSvg).toContain("fill=\"currentColor\"");

      // Must use SVG namespace
      expect(logoSvg).toContain("xmlns=");
    });

    it("logo.svg does not contain retired 4-circle glyph pattern", () => {
      const logoSvg = readFileSync(resolve(__dirname, "../public/logo.svg"), "utf8");

      // The old 4-circle glyph used circles at (44,44), (84,44), (44,84), (84,84) with r=20
      // Verify these specific circle positions are NOT present
      expect(logoSvg).not.toContain("cx=\"44\"");
      expect(logoSvg).not.toContain("cy=\"44\"");
      expect(logoSvg).not.toContain("r=\"20\"");
    });

    it("PWA icon files exist, decode to expected sizes, and are opaque non-blank PNGs", () => {
      const icons = [
        { path: resolve(__dirname, "../public/icons/icon-192.png"), size: 192 },
        { path: resolve(__dirname, "../public/icons/icon-512.png"), size: 512 },
      ];

      for (const icon of icons) {
        expect(existsSync(icon.path)).toBe(true);
        expect(statSync(icon.path).size).toBeGreaterThan(icon.size * 12);

        const png = decodeRgbaPng(icon.path);
        expect(png.width).toBe(icon.size);
        expect(png.height).toBe(icon.size);
        expect(png.colorType).toBe(6);

        let opaquePixels = 0;
        let transparentPixels = 0;
        let brandMarkPixels = 0;
        const brandBackground = [0x1a, 0x1a, 0x2e];

        for (let index = 0; index < png.pixels.length; index += 4) {
          const alpha = png.pixels[index + 3];
          if (alpha === 255) opaquePixels += 1;
          else transparentPixels += 1;

          const colorDistance =
            Math.abs(png.pixels[index] - brandBackground[0]) +
            Math.abs(png.pixels[index + 1] - brandBackground[1]) +
            Math.abs(png.pixels[index + 2] - brandBackground[2]);
          if (colorDistance > 8) brandMarkPixels += 1;
        }

        expect(transparentPixels).toBe(0);
        expect(opaquePixels).toBe(icon.size * icon.size);
        expect(brandMarkPixels).toBeGreaterThan(icon.size * icon.size * 0.1);
      }
    });

    it("wires the same PWA icons through manifest, apple touch, and service-worker precache", () => {
      const manifest = JSON.parse(readFileSync(resolve(__dirname, "../public/manifest.json"), "utf8")) as {
        icons?: Array<{ src?: string; sizes?: string; purpose?: string }>;
      };
      const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf8");
      const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");
      const iconSources = ["/icons/icon-192.png", "/icons/icon-512.png"];

      for (const iconSource of iconSources) {
        expect(manifest.icons?.some((icon) => icon.src === iconSource && icon.purpose === "any")).toBe(true);
        expect(swSource).toContain(`"${iconSource}"`);
      }

      expect(indexHtml).toContain('<link rel="icon" type="image/svg+xml" href="/logo.svg" />');
      expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/icons/icon-192.png" />');
      expect(swSource).toContain('const CACHE_NAME = "fusion-cache-v7";');
    });
  });
});
