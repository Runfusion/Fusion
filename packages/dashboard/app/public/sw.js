/*
FNXC:PWAOffline 2026-07-26-18:05:
Bumped v6 -> v7 to EVACUATE already-persisted credentials. Until this change every successful GET /api/*
response was written to Cache Storage, including GET /api/settings and /api/settings/global, whose bodies
carry plaintext `daemonToken`, `githubAuthToken`, `gitlabAuthToken`, and `ntfyAccessToken`. Adding the
allow-list below stops NEW writes but cannot reach entries an installed worker already wrote; `activate`
deletes every cache whose key !== CACHE_NAME, so the rename is the only mechanism that removes them from
durable origin storage on an existing install. Any future change to what may be cached must bump this too.
*/
const CACHE_NAME = "fusion-cache-v7";

/*
FNXC:PWAOffline 2026-07-26-10:12:
Mobile browsers (iOS Safari tabs, iOS installed PWAs, Chrome Android) discard backgrounded pages under memory pressure. When the user returns, the tab is re-navigated from scratch, so restore cost IS the perceived bug: a network-first bundle refetch pulls ~2.8MB raw / 750KB gzipped of entry chunk (14MB across ~130 chunks) over a just-waking radio before anything paints, producing the white splash.

Vite emits content-hashed asset filenames (`[name]-[hash].[ext]`), so a hashed URL's bytes can never change — a new build emits a NEW url. Those are therefore safe to serve cache-first: a cache hit is authoritative, and a post-deploy hash simply misses and is fetched. HASHED_ASSET_PATTERN is the conservative gate for that guarantee; anything under /assets/ that does not prove it carries a hash stays network-first.

Conservatism rules for the pattern: the trailing dash-delimited segment of the basename must be >=8 chars of Vite's base64url hash alphabet (dash permitted only as the final character, which keeps the segment genuinely trailing instead of letting the match span earlier dashes) AND must contain at least one uppercase letter or digit. Human-authored kebab-case basenames (`vendor-runtime.js`, `foo-bar-baz.css`) fail the mixed-alphabet check and stay network-first. A real hash fails the pattern only when it embeds a dash before its last character (~10% of hashes) or is all-lowercase-alpha ((28/64)^8, ~0.1%); both are harmless downgrades to the previous network-first behavior, never a stale-serve.
*/
const HASHED_ASSET_PATTERN = /-(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9_]{7,}[A-Za-z0-9_-]?\.[A-Za-z0-9]+$/;

/**
 * FNXC:PWAOffline 2026-07-26-10:18:
 * Cache-first eligibility. Two admissible classes:
 * 1. Content-hashed build assets under /assets/ — immutable by construction (see HASHED_ASSET_PATTERN).
 * 2. Font requests (`request.destination === "font"`, e.g. the preloaded /fonts/SymbolsNerdFontMono-Regular.ttf) — not hash-named, but immutable in practice; a replaced font is picked up on the next CACHE_NAME bump. Blocking first paint on a font refetch over a waking radio is not worth that staleness window.
 *
 * Deliberately NOT admissible to the CACHE-FIRST path: the navigation shell, /api/*, and non-hashed
 * scripts/styles. (Corrected 2026-07-26-18:05: the previous wording — "Deliberately NOT admissible" —
 * read as a blanket exclusion from the cache. It never was one: those classes are merely network-FIRST
 * and were still written to the same cache as an offline fallback. That misreading is how credential-
 * bearing /api/ responses sat in durable storage unnoticed. What may be WRITTEN for /api/ is decided
 * solely by isCacheableApiUrl() below, not by this predicate.)
 *
 * @param {URL} url
 * @param {Request} request
 * @returns {boolean}
 */
function isImmutableAssetRequest(url, request) {
  if (request.destination === "font") {
    return true;
  }
  return url.pathname.startsWith("/assets/") && HASHED_ASSET_PATTERN.test(url.pathname);
}

/*
FNXC:PWAOffline 2026-07-26-14:05:
Cache-first hashed assets made cache SIZE load-bearing, and nothing evicted within a generation — `activate` only drops caches whose key !== CACHE_NAME, and CACHE_NAME is a hand-bumped literal. Fusion is self-hosted and rebuilt constantly (Command Center "Rebuild + restart" reloads the page onto a new build), each build emitting ~130 fresh hashed chunks (~14MB). Every prior build's chunks stayed resident forever, so a week of daily rebuilds parks ~100MB of dead chunks on the origin. On iOS the origin quota is enforced per-origin and eviction is ALL-OR-NOTHING for the bucket: blowing it wipes localStorage too, taking out the SWR board snapshot and the `kb-dashboard-*` preferences that the rest of the restore work depends on. So the unbounded cache does not merely waste disk — it can destroy the very state that makes restore cheap.

Chosen bound: an insertion-ordered entry cap over hashed /assets/ entries only.
- Why not "keep only what the current index.html references": index.html names only the entry chunk; the other ~129 are lazy imports discovered inside JS. Reconstructing that graph in the SW means parsing bundles — fragile, and a mis-parse strands the user on a failed dynamic import.
- Why not a CACHE_NAME-per-build bump: correct in principle, but CACHE_NAME is a literal in a static, untemplated file. Doing it properly needs build-time templating of sw.js (a Vite plugin emitting the build hash) — real build wiring, not a one-line change, and out of scope here. Recorded as the eventual better answer rather than faked with a hardcoded hash.
- Why insertion order is the right recency proxy: hashed URLs are immutable, so an entry is only ever inserted once, at the moment its build first ran. Cache API `keys()` is specified to return entries in insertion order, so oldest-first == oldest-build-first. Evicting from the front removes dead builds before live ones, with no metadata bookkeeping to persist or corrupt.

Partial safety against evicting an asset the RUNNING build still needs: every hashed URL this service-worker SESSION has served (hit or miss) is recorded in `sessionReferencedAssets` and is exempt from eviction while it remains in that set (itself bounded — see MAX_SESSION_REFERENCED_ASSETS).

CORRECTION 2026-07-26-18:05 — the previous wording ("A chunk the current page has already loaded is thereby pinned") asserted a guarantee this code does not deliver, and the claim must not be reintroduced. `sessionReferencedAssets` is an in-memory Set in the worker's global scope, and browsers idle-terminate a service worker after ~30s of no events — the normal state of a BACKGROUNDED tab, i.e. exactly the scenario this feature exists for. The worker that wakes to serve the restored tab is a cold start with an EMPTY set, so on the first prune after every wake NOTHING is pinned.

What actually bounds the residual risk, and why it was left as-is rather than papered over:
- Eviction is oldest-INSERTED-first, and the running build's chunks are the most recently inserted, so the natural ordering already protects them in the common case. The pin set only adds protection in the uncommon inversion where a live build's chunks are older than some other build's — e.g. a long-lived tab on build N while another tab loaded build N+1.
- Durably persisting the set would re-pin a PREVIOUS build's chunks on every restart with no way to tell which build is now live, converting a bounded eviction risk into an unbounded pinning one. Not worth it for the inversion case.
- The failure mode is a re-fetch, not a break: an evicted chunk still on the server is fetched again. The only unrecoverable case (chunk gone from the server) is the stale-chunk case `versionCheck.ts`'s handleChunkLoadError/isStaleChunkError already handles, and it would occur with no cache at all.
*/
const MAX_IMMUTABLE_CACHE_ENTRIES = 200;

/*
FNXC:PWAOffline 2026-07-26-14:05:
The eviction-exemption set must itself be bounded, or it re-opens the hole it exists to make safe: a
service worker that survives many rebuilds (they are cheap to keep alive under active use) would
accumulate every build's served chunks as permanently-exempt and the cap could never bite. Capping it
drop-oldest makes the resident set provably bounded at MAX_IMMUTABLE_CACHE_ENTRIES +
MAX_SESSION_REFERENCED_ASSETS in the worst case rather than unbounded. Dropping the oldest exemption
is safe for the same reason eviction is: a chunk evicted but still needed is re-fetched from the
network, and the only unrecoverable case (build gone from the server) is the stale-chunk case
versionCheck.ts handles and would occur with no cache at all.
*/
const MAX_SESSION_REFERENCED_ASSETS = 200;

/** @type {Set<string>} URLs of hashed assets served during this SW session; exempt from eviction. Set iteration is insertion-ordered, so the first entry is the oldest. */
const sessionReferencedAssets = new Set();

/**
 * @param {string} requestUrl
 * @returns {void}
 */
function rememberSessionReferencedAsset(requestUrl) {
  sessionReferencedAssets.delete(requestUrl);
  sessionReferencedAssets.add(requestUrl);
  while (sessionReferencedAssets.size > MAX_SESSION_REFERENCED_ASSETS) {
    const oldest = sessionReferencedAssets.values().next();
    if (oldest.done) {
      break;
    }
    sessionReferencedAssets.delete(oldest.value);
  }
}

/*
FNXC:PWAOffline 2026-07-26-15:40:
The hashed-asset cap above left the OTHER unbounded writer in this file untouched: every GET /api/ response is put into the same CACHE_NAME and nothing ever evicted those entries. The dashboard issues a large and open-ended set of distinct /api/ URLs (per project, per task, per query string), so the API half grew without limit — the same iOS all-or-nothing per-origin quota hazard the asset cap exists to prevent, where blowing the bucket wipes localStorage (SWR board snapshot, `kb-dashboard-*` prefs) alongside the caches.

Size is only half the defect. This cache is the OFFLINE FALLBACK: on a network failure a cached entry is served transparently to the app, which cannot tell it apart from a live response. With no expiry, an hours-old task list could be handed to the board during a brief radio blip — a correctness bug worse than the failed fetch it papers over. So the API entries get BOTH a count cap and a freshness bound.

Why not "stop caching /api/ entirely": the fallback is cheap and does earn a narrow keep. Warm hydration is NOT what depends on it — the app hydrates from its own localStorage/session snapshots — but a mobile tab restored onto a waking radio issues its first API burst before the connection settles, and a seconds-to-minutes-old response there is strictly better than an error state. That value evaporates fast, hence a short TTL rather than an unbounded fallback.

Freshness accounting, in precedence order:
1. `apiCacheTimestamps` — recorded at put time, same clock as the read, exact.
2. the response's `Date` header — Fusion serves its own API from Node, which always sets it, so a service worker that restarted (the common case after a discard) can still prove age.
3. otherwise UNKNOWN, which counts as stale. Fail-closed: an entry whose age cannot be proven is never served. The cost is one failed request that would have failed anyway without a cache; the alternative is exactly the unbounded-staleness bug being fixed.
A negative age (client clock behind the server's) is also treated as unprovable rather than clamped to fresh, so clock skew cannot mint an immortal entry.
*/
const MAX_API_CACHE_ENTRIES = 100;

/** Freshness bound for the /api/ offline fallback. Long enough to cover a radio blip, short enough that no stale board can surface. */
const MAX_API_CACHE_AGE_MS = 5 * 60 * 1000;

/*
FNXC:PWAOffline 2026-07-26-18:05:
WHICH /api/ responses may be written at all. Previously: every successful GET /api/*. That included
GET /api/settings and /api/settings/global, which return `daemonToken`, `githubAuthToken`,
`gitlabAuthToken`, and `ntfyAccessToken` as plaintext — so dashboard credentials were persisted to
durable Cache Storage, survived logout, token rotation, and project switch (nothing in the app touched
the caches API until the purge added in swrCache.ts), and were readable by any script on the origin.
The entry cap and TTL added earlier bound size and staleness; neither is a confidentiality control.

ALLOW-list, not deny-list. A deny-list fails OPEN: every endpoint added later is cached until someone
remembers to exclude it, which is exactly how the credential endpoints got here. The allow-list fails
closed — a new endpoint is network-only until someone argues it into this list.

What earns a place: only reads whose offline fallback has real value on the mobile-restore path this
whole feature targets (a restored tab issues its first API burst before the radio settles, where a
seconds-old body beats an error state) AND whose bodies carry no credential, secret, or token.
- `/api/tasks` and `/api/tasks/<id>`: the board and the card the user was looking at.
- `/api/projects`: the project list the board is keyed by.
Everything else — settings, secrets, auth, agents, git, chat, artifacts, attachments — goes straight to
the network with no cache write and no fallback read. The cost is an error state on a blip for those
views; the alternative is deciding, endpoint by endpoint forever, whether a body is sensitive.
*/
const API_CACHE_ALLOWLIST = [
  /^\/api\/tasks$/,
  /^\/api\/tasks\/[^/]+$/,
  /^\/api\/projects$/,
];

/*
FNXC:PWAOffline 2026-07-26-18:05:
Defense in depth over the allow-list, not a substitute for it. `appendTokenQuery` (auth.ts) puts the
dashboard bearer token in the URL as `fn_token=<token>` for transports that cannot set headers
(TaskDetailModal attachments, artifactMediaUrl, file downloads). A cache key IS the URL, so caching such
a request would persist the token itself as a durable key. None of those paths are allow-listed today;
this guard makes that a property of the code rather than of the current allow-list's shape.
*/
const CREDENTIAL_QUERY_PARAMS = ["fn_token", "token", "ticket", "access_token"];

/**
 * FNXC:PWAOffline 2026-07-26-18:05:
 * @param {string} requestUrl
 * @returns {boolean} true when this URL may be written to / read from the offline fallback cache.
 */
function isCacheableApiUrl(requestUrl) {
  try {
    const url = new URL(requestUrl);
    for (const param of CREDENTIAL_QUERY_PARAMS) {
      if (url.searchParams.has(param)) {
        return false;
      }
    }
    return API_CACHE_ALLOWLIST.some((pattern) => pattern.test(url.pathname));
  } catch {
    return false;
  }
}

/*
FNXC:PWAOffline 2026-07-26-18:05:
Durable put-time stamp. `apiCacheTimestamps` is a plain Map in the service worker's global scope, and
browsers idle-terminate a service worker after ~30s — which is precisely what happens while the tab is
backgrounded, the scenario this feature exists for. So on the next wake the SW cold-starts with that Map
EMPTY and every surviving entry's age had to be proven from the server `Date` header alone. That header
is a real fallback but it is the ORIGIN's send time, not our put time, and an intermediary or a response
replayed from an HTTP cache can make it arbitrarily older than the entry. Stamping our own header at put
time makes age provable across a worker restart with the same clock the read uses.

Fails soft by design: if `Response`/`Headers` are unavailable, the status cannot carry a body (204/304),
or the body read throws, the caller falls back to putting the plain clone and age falls back to `Date`.
A failure here must never cost the response itself.
*/
const SW_CACHED_AT_HEADER = "x-fusion-sw-cached-at";

/**
 * @param {Response} response
 * @returns {Promise<Response|undefined>} a stamped copy, or undefined when stamping is not possible.
 */
async function buildStampedResponse(response) {
  if (typeof Response !== "function" || typeof Headers !== "function") {
    return undefined;
  }
  if (!response || !response.headers || typeof response.clone !== "function") {
    return undefined;
  }
  // Response's constructor rejects a body for these statuses; leave them to the plain-clone path.
  if (response.status === 204 || response.status === 205 || response.status === 304 || !response.status) {
    return undefined;
  }
  const headers = new Headers(response.headers);
  headers.set(SW_CACHED_AT_HEADER, String(Date.now()));
  const body = await response.clone().arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/*
FNXC:PWAOffline 2026-07-26-15:40:
Unlike hashed assets (written only on the cold path, when a new build arrives), EVERY api response is a
cache put, so scheduling a full keys() scan per put would put an O(cache) walk behind ordinary polling.
Pruning every Nth put bounds the API entry count at limit + N instead of limit exactly, which is fine:
the cap is a quota guard, not a contract. Expiry is NOT lazy in the way that matters — it is enforced on
every read of the fallback path; the prune-side expiry sweep only reclaims disk.
*/
const API_PRUNE_PUT_INTERVAL = 10;

/** @type {Map<string, number>} api URL -> epoch ms of its cache put. Insertion-ordered, so the first entry is the oldest. */
const apiCacheTimestamps = new Map();

let apiPutsSincePrune = 0;

/**
 * @param {string} requestUrl
 * @returns {void}
 */
function rememberApiCacheTimestamp(requestUrl) {
  apiCacheTimestamps.delete(requestUrl);
  apiCacheTimestamps.set(requestUrl, Date.now());
  while (apiCacheTimestamps.size > MAX_API_CACHE_ENTRIES) {
    const oldest = apiCacheTimestamps.keys().next();
    if (oldest.done) {
      break;
    }
    apiCacheTimestamps.delete(oldest.value);
  }
}

/**
 * @param {string} requestUrl
 * @param {Response|undefined} cachedResponse
 * @returns {number|undefined} epoch ms the entry was cached, or undefined when unprovable.
 */
function readApiCachedAtMillis(requestUrl, cachedResponse) {
  const remembered = apiCacheTimestamps.get(requestUrl);
  if (typeof remembered === "number") {
    return remembered;
  }
  try {
    const headers = cachedResponse && cachedResponse.headers ? cachedResponse.headers : null;
    // FNXC:PWAOffline 2026-07-26-18:05: our own put-time stamp outranks `Date` — it survives the
    // SW idle-termination that empties apiCacheTimestamps and is on the same clock as this read.
    const stamped = headers ? headers.get(SW_CACHED_AT_HEADER) : null;
    if (stamped) {
      const parsedStamp = Number(stamped);
      if (Number.isFinite(parsedStamp)) {
        return parsedStamp;
      }
    }
    const dateHeader = headers ? headers.get("date") : null;
    if (dateHeader) {
      const parsed = Date.parse(dateHeader);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  } catch (headerError) {
    console.warn("[sw] api cache date header read failed", headerError);
  }
  return undefined;
}

/**
 * @param {number|undefined} cachedAtMillis
 * @returns {boolean} true only when the entry's age is provable AND within the freshness bound.
 */
function isFreshApiCacheEntry(cachedAtMillis) {
  if (typeof cachedAtMillis !== "number" || !Number.isFinite(cachedAtMillis)) {
    return false;
  }
  const age = Date.now() - cachedAtMillis;
  return age >= 0 && age <= MAX_API_CACHE_AGE_MS;
}

/**
 * @param {string} requestUrl
 * @returns {boolean}
 */
function isApiCacheUrl(requestUrl) {
  try {
    const pathname = new URL(requestUrl).pathname;
    // /api/events* never reaches the cache (SSE bypasses the SW), so it is not a prunable class.
    return pathname.startsWith("/api/") && pathname !== "/api/events" && !pathname.startsWith("/api/events/");
  } catch {
    return false;
  }
}

/** Prune runs are single-flight; overlapping cold-path misses must not scan/delete concurrently. */
let immutablePruneInFlight = false;

/**
 * FNXC:PWAOffline 2026-07-26-14:05:
 * URL-only classifier for prunable entries. Deliberately does NOT reuse isImmutableAssetRequest():
 * that one consults `request.destination`, which is not guaranteed to survive a round trip through
 * the Cache API on a `keys()` result. Fonts therefore fall outside the prunable set — there are a
 * handful of them and they are not the growth term.
 *
 * @param {string} requestUrl
 * @returns {boolean}
 */
function isPrunableAssetUrl(requestUrl) {
  try {
    const pathname = new URL(requestUrl).pathname;
    return pathname.startsWith("/assets/") && HASHED_ASSET_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

/*
FNXC:PWAOffline 2026-07-26-15:40:
Both bounded classes (hashed assets, /api/ responses) share ONE policy-driven sweep over ONE keys()
scan rather than two parallel implementations walking the cache separately. A policy declares which
URLs it owns, its entry cap, which entries are pinned, and which are provably expired.

`isExpired` is deliberately allowed to answer only for entries whose age is PROVABLE. An /api/ entry
with no recorded timestamp is never served (see isFreshApiCacheEntry) but is also not force-evicted
here; the cap reclaims it in insertion order. This keeps the sweep from deleting entries it cannot
reason about — e.g. those written by a previous SW session — as a side effect of an asset prune.

Amended 2026-07-26-18:05: be explicit that after an idle-termination cold start BOTH in-memory
structures are empty, so a prune then sees zero pinned assets and zero provably-expired API entries and
degrades to a pure oldest-first cap sweep. That is correct behavior, not a gap: the cap is the quota
guard, and the freshness guarantee lives on the READ path (isFreshApiCacheEntry via the durable
SW_CACHED_AT_HEADER stamp), which never depends on these maps surviving. `isExpired` deliberately does
not open each entry to read that header — that would turn the sweep into an O(cache) match() storm on
the hot path to reclaim disk it will reclaim by cap anyway.

Entries outside every policy (the navigation shell, unhashed assets, fonts, icons) are a small fixed
set and stay untouched, as before.

@type {Array<{name: string, limit: number, owns: (url: string) => boolean, isPinned: (url: string) => boolean, isExpired: (url: string) => boolean, forget: (url: string) => void}>}
*/
const CACHE_PRUNE_POLICIES = [
  {
    name: "immutable-asset",
    limit: MAX_IMMUTABLE_CACHE_ENTRIES,
    owns: isPrunableAssetUrl,
    isPinned: (url) => sessionReferencedAssets.has(url),
    isExpired: () => false,
    forget: () => undefined,
  },
  {
    name: "api",
    limit: MAX_API_CACHE_ENTRIES,
    owns: isApiCacheUrl,
    isPinned: () => false,
    isExpired: (url) => {
      const cachedAt = apiCacheTimestamps.get(url);
      return typeof cachedAt === "number" && !isFreshApiCacheEntry(cachedAt);
    },
    forget: (url) => {
      apiCacheTimestamps.delete(url);
    },
  },
];

/**
 * FNXC:PWAOffline 2026-07-26-14:05 (generalized 2026-07-26-15:40):
 * Evict per policy until each bounded class is back under its cap: provably-expired entries first
 * (they can never be served, so they are pure reclaimed quota), then oldest-inserted, skipping
 * anything pinned. If every over-cap entry is pinned the sweep simply does less work than requested —
 * never evicting a live chunk is more important than hitting the cap exactly. Fully defensive: it is
 * invoked fire-and-forget so a throw, a rejected delete, or a slow keys() scan can never delay or
 * fail the fetch response it was triggered from.
 *
 * @param {Cache} cache
 * @returns {Promise<void>}
 */
async function pruneBoundedCacheEntries(cache) {
  if (immutablePruneInFlight) {
    return;
  }
  immutablePruneInFlight = true;
  try {
    const keys = await cache.keys();
    const buckets = CACHE_PRUNE_POLICIES.map(() => ({ total: 0, expired: [], evictable: [] }));

    for (const cachedRequest of keys) {
      if (!cachedRequest) {
        continue;
      }
      for (let index = 0; index < CACHE_PRUNE_POLICIES.length; index += 1) {
        const policy = CACHE_PRUNE_POLICIES[index];
        if (!policy.owns(cachedRequest.url)) {
          continue;
        }
        const bucket = buckets[index];
        bucket.total += 1;
        if (policy.isExpired(cachedRequest.url)) {
          bucket.expired.push(cachedRequest);
        } else if (!policy.isPinned(cachedRequest.url)) {
          bucket.evictable.push(cachedRequest);
        }
        break;
      }
    }

    for (let index = 0; index < CACHE_PRUNE_POLICIES.length; index += 1) {
      const policy = CACHE_PRUNE_POLICIES[index];
      const bucket = buckets[index];
      let overflow = bucket.total - policy.limit;

      // Expired entries are dropped regardless of overflow; they are unservable dead weight.
      for (const cachedRequest of bucket.expired) {
        try {
          await cache.delete(cachedRequest);
          policy.forget(cachedRequest.url);
          overflow -= 1;
        } catch (deleteError) {
          console.warn(`[sw] ${policy.name} expired eviction failed`, deleteError);
        }
      }

      for (const cachedRequest of bucket.evictable) {
        if (overflow <= 0) {
          break;
        }
        try {
          await cache.delete(cachedRequest);
          policy.forget(cachedRequest.url);
          overflow -= 1;
        } catch (deleteError) {
          console.warn(`[sw] ${policy.name} eviction failed`, deleteError);
        }
      }
    }
  } catch (error) {
    console.warn("[sw] cache prune failed", error);
  } finally {
    immutablePruneInFlight = false;
  }
}

/**
 * FNXC:PWAOffline 2026-07-26-14:05:
 * Fire-and-forget prune trigger. Runs on the cold path only (after a cache MISS populated a new
 * entry, i.e. exactly when a new build is arriving) and on activate. Not awaited: awaiting would put
 * an O(cache) keys() scan in front of each of a new build's ~130 first-load chunk responses.
 *
 * @param {Cache} cache
 * @returns {void}
 */
function schedulePrune(cache) {
  try {
    void pruneBoundedCacheEntries(cache);
  } catch (error) {
    console.warn("[sw] cache prune scheduling failed", error);
  }
}

/**
 * FNXC:PWAOffline 2026-07-26-15:40:
 * Throttled prune trigger for the /api/ hot path — see API_PRUNE_PUT_INTERVAL. The counter advances
 * before the guard so a throwing prune cannot wedge the interval.
 *
 * @param {Cache} cache
 * @returns {void}
 */
function scheduleApiPrune(cache) {
  apiPutsSincePrune += 1;
  if (apiPutsSincePrune < API_PRUNE_PUT_INTERVAL) {
    return;
  }
  apiPutsSincePrune = 0;
  schedulePrune(cache);
}

const APP_SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/logo.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

/*
FNXC:PWAOffline 2026-07-26-18:05:
Operator-triggered Cache Storage purge, the service-worker half of `clearAllLocalCache()` (swrCache.ts).
Settings -> "Clear all cached data" wipes localStorage and then immediately reloads the page, which can
abort an in-page `caches.delete()` mid-flight. The service worker is NOT torn down by that reload, so
routing the purge through it is what makes the delete actually land. The page still performs its own
direct purge as well: a page with no controlling worker (first load, dev without SW) would otherwise get
no purge at all. Both paths are idempotent — deleting an absent cache is a no-op.
*/
const PURGE_CACHES_MESSAGE = "PURGE_CACHES";

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event.data && event.data.type === PURGE_CACHES_MESSAGE) {
    const purge = (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
        // In-memory bookkeeping describes entries that no longer exist; leaving it would let a
        // subsequent read believe a deleted URL still has a provable put time.
        apiCacheTimestamps.clear();
        sessionReferencedAssets.clear();
      } catch (error) {
        console.warn("[sw] cache purge failed", error);
      }
    })();
    if (event.waitUntil) {
      event.waitUntil(purge);
    }
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL_URLS);
      await self.skipWaiting();
    } catch (error) {
      console.warn("[sw] install cache warmup failed", error);
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      // FNXC:PWAOffline 2026-07-26-14:05: cross-generation eviction above only fires on a
      // CACHE_NAME bump; this bounds the CURRENT generation on every SW activation too.
      try {
        const cache = await caches.open(CACHE_NAME);
        await pruneBoundedCacheEntries(cache);
      } catch (pruneError) {
        console.warn("[sw] activate prune failed", pruneError);
      }
      await self.clients.claim();
    } catch (error) {
      console.warn("[sw] activate cleanup failed", error);
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  const accept = request.headers.get("accept") ?? "";
  const isApiRequest = url.pathname.startsWith("/api/");
  const isEventStreamRequest =
    accept.includes("text/event-stream") ||
    url.pathname === "/api/events" ||
    url.pathname.startsWith("/api/events/");
  const isNavigationRequest =
    request.mode === "navigate" ||
    request.destination === "document" ||
    url.pathname === "/" ||
    url.pathname === "/index.html";
  const isBuiltAssetRequest =
    url.pathname.startsWith("/assets/") ||
    request.destination === "script" ||
    request.destination === "style";
  // NOTE: `request.destination === "font"` used to be listed here. Fonts are
  // now claimed by isImmutableAssetRequest() above, so repeating them would be
  // an unreachable branch.

  // EventSource requests stay open indefinitely. Waiting on cache.put() for an
  // infinite response body prevents the browser from ever receiving the stream
  // and leaks the underlying connection across reloads. Let SSE bypass the
  // service worker entirely so the browser talks to the network directly.
  if (isEventStreamRequest) {
    return;
  }

  /*
  FNXC:PWAOffline 2026-07-26-10:24:
  The navigation shell MUST stay network-first. index.html is the only unhashed document in the graph, so it is the single source of truth for which hashed asset URLs are current. Keeping it fresh is precisely what makes cache-first hashed assets safe: after a deploy the fresh shell names new hashes, those miss the cache, and are fetched. Serving the shell from cache would pin the tab to a previous build's hashes indefinitely. Cache remains an offline fallback only.
  */
  if (isNavigationRequest) {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(request);
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, networkResponse.clone());
        } catch (cacheError) {
          console.warn("[sw] navigation cache put failed", cacheError);
        }
        return networkResponse;
      } catch (networkError) {
        const fallback = await caches.match(request);
        if (fallback) {
          return fallback;
        }
        throw networkError;
      }
    })());
    return;
  }

  /*
  FNXC:PWAOffline 2026-07-26-15:40 (amended 2026-07-26-18:05):
  /api/ stays network-first; the cache is a fallback for a failed request only, and ONLY for the
  allow-listed, credential-free URLs isCacheableApiUrl() admits. Three bounds apply here
  (rationale at MAX_API_CACHE_ENTRIES): the put records a timestamp and throttle-schedules the shared
  prune so the entry count cannot grow without limit, and the fallback read refuses any entry whose
  age is not provably within MAX_API_CACHE_AGE_MS — an expired or unprovable entry is deleted and the
  original network error is rethrown, so the app sees a failed request instead of silently rendering
  stale data it cannot distinguish from live data.
  */
  if (isApiRequest) {
    /*
    FNXC:PWAOffline 2026-07-26-18:05:
    Confidentiality gate, evaluated BEFORE any cache is opened: a non-allow-listed /api/ URL is passed
    through untouched — no put, and no fallback read either. The read side matters as much as the write
    side: an entry left behind by an older worker generation must not become servable just because this
    generation stopped writing it. Returning without respondWith() lets the browser perform the request
    directly, which is also the cheapest possible path.
    */
    if (!isCacheableApiUrl(request.url)) {
      return;
    }
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(request);
        /*
        FNXC:PWAOffline 2026-07-26-18:05:
        Only `response.ok` is cached — the same rule the immutable-asset branch already applied, which
        this branch was missing. Caching a failure body makes the offline fallback actively wrong rather
        than merely stale: a 401 taken right after a token rotation, or a 500 from a restarting daemon,
        would be replayed on the next network blip as a response the app cannot distinguish from live,
        and an error body carries none of the freshness value the fallback exists for.
        */
        if (!networkResponse || !networkResponse.ok) {
          return networkResponse;
        }
        try {
          const cache = await caches.open(CACHE_NAME);
          // FNXC:PWAOffline 2026-07-26-18:05: stamp the put time into the stored entry so a
          // cold-started worker (see buildStampedResponse) can still prove this entry's age.
          let entryToCache = networkResponse.clone();
          try {
            const stamped = await buildStampedResponse(networkResponse);
            if (stamped) {
              entryToCache = stamped;
            }
          } catch (stampError) {
            console.warn("[sw] api cache stamp failed", stampError);
          }
          await cache.put(request, entryToCache);
          rememberApiCacheTimestamp(request.url);
          scheduleApiPrune(cache);
        } catch (cacheError) {
          console.warn("[sw] api cache put failed", cacheError);
        }
        return networkResponse;
      } catch (networkError) {
        try {
          const cache = await caches.open(CACHE_NAME);
          const cachedResponse = await cache.match(request);
          if (cachedResponse) {
            if (isFreshApiCacheEntry(readApiCachedAtMillis(request.url, cachedResponse))) {
              return cachedResponse;
            }
            try {
              await cache.delete(request);
              apiCacheTimestamps.delete(request.url);
            } catch (deleteError) {
              console.warn("[sw] api stale fallback eviction failed", deleteError);
            }
          }
        } catch (cacheError) {
          console.warn("[sw] api cache lookup failed", cacheError);
        }
        throw networkError;
      }
    })());
    return;
  }

  /*
  FNXC:PWAOffline 2026-07-26-10:31:
  Immutable assets are served CACHE-FIRST: a hit returns without touching the network, so a discarded-and-restored mobile tab repaints from local storage instead of re-downloading the bundle over a waking radio. On a miss we fetch, populate, and return.

  This replaces the previous network-first-for-everything rule, which existed out of a stale-JS fear. That fear does not apply here: the URL is content-hashed, so its bytes are immutable and a hit can never be "stale" — a rebuild produces a different URL, which misses. The fear DOES apply to the navigation shell, which is why that branch above is left network-first.

  Only `response.ok` is cached. A hashed URL that 404s (deploy mid-flight, partially uploaded build) must never be pinned into an immutable cache entry, because nothing would ever evict it before the next CACHE_NAME bump.
  */
  if (isImmutableAssetRequest(url, request)) {
    event.respondWith((async () => {
      // FNXC:PWAOffline 2026-07-26-14:05: recorded BEFORE the hit/miss branch so an asset the
      // running build is using is eviction-exempt whether it came from cache or network.
      rememberSessionReferencedAsset(request.url);
      try {
        const cache = await caches.open(CACHE_NAME);
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
          return cachedResponse;
        }

        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.ok) {
          try {
            await cache.put(request, networkResponse.clone());
            schedulePrune(cache);
          } catch (cacheError) {
            console.warn("[sw] immutable asset cache put failed", cacheError);
          }
        }
        return networkResponse;
      } catch (error) {
        console.warn("[sw] immutable asset cache flow failed", error);
        const fallback = await caches.match(request);
        if (fallback) {
          return fallback;
        }
        return fetch(request);
      }
    })());
    return;
  }

  // Non-hashed built assets (unhashed scripts/styles, anything under /assets/
  // that cannot prove it carries a content hash) keep the network-first path:
  // their URL is not a content identity, so a cached copy can genuinely go
  // stale and blank the app after an update. Cache stays an offline fallback.
  if (isBuiltAssetRequest) {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(request);
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, networkResponse.clone());
        } catch (cacheError) {
          console.warn("[sw] asset cache put failed", cacheError);
        }
        return networkResponse;
      } catch (networkError) {
        try {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) {
            return cachedResponse;
          }
        } catch (cacheError) {
          console.warn("[sw] asset cache lookup failed", cacheError);
        }
        throw networkError;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(request);
      if (cachedResponse) {
        return cachedResponse;
      }

      const networkResponse = await fetch(request);
      await cache.put(request, networkResponse.clone());
      return networkResponse;
    } catch (error) {
      console.warn("[sw] static cache flow failed", error);
      return fetch(request);
    }
  })());
});
