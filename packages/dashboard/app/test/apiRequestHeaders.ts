/*
FNXC:TaskDeleteAttribution 2026-07-30-20:20 (re-green the API client tests, once):
THE canonical request-header shape the dashboard API client emits, in ONE place.

Why this exists rather than 114 literals. `api()` in `app/api/client.ts` builds headers through
`new Headers(...)` and returns `Object.fromEntries(headers.entries())`, and `Headers.entries()`
LOWERCASES every key — so the object that reaches `fetch` is `content-type`, not `Content-Type`.
`ab87d0d80` then added `x-fusion-client: dashboard-ui` for run-audit attribution (telling an
operator's click apart from an unlabeled script hitting the same endpoint).

Both changes were correct and neither is visible at a call site, so 114 assertions across 7 files
kept asserting the old shape and went red together. Restating a shared fact 114 times is what made a
two-line client change look like 114 failures; naming it once means the next header addition is one
edit here, and the assertions keep checking what they are actually about — the URL and the body.

Deliberately NOT a loose `expect.objectContaining`: these tests are the only thing pinning that the
attribution header is sent AT ALL. Matching the exact object is the point — a header silently dropped
must fail here.
*/

/** Exact `headers` object the client sends for an unauthenticated JSON request. */
export const API_JSON_HEADERS = {
  "content-type": "application/json",
  "x-fusion-client": "dashboard-ui",
} as const;

/**
 * The same, plus any extra headers a specific call adds (e.g. an auth token).
 * Keys are lowercased to match what `Headers.entries()` produces.
 */
export function apiJsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(extra)) lowered[key.toLowerCase()] = value;
  return { ...API_JSON_HEADERS, ...lowered };
}

/*
FNXC:TaskDeleteAttribution 2026-07-30-20:35 (a GAP the re-green surfaced, recorded not hidden):
Some api-layer functions call `fetch()` DIRECTLY instead of going through `api()`, so they never get
the attribution header. `client.ts` states the opposite — "Applied once here rather than per-call so no
future mutation route has to remember it" — and that claim does not hold for a route that bypasses the
helper it is applied in.

MEASURED in `app/api/`: 8 files make direct `fetch()` calls, and 7 of those include mutations
(POST/DELETE) — among them `ai-sessions.ts`'s DELETE, which is the same class as the four-delete
incident the header was added for. `fetchTaskDetail` is the read that this constant exists for.

Not fixed here: routing those calls through `api()` is a behaviour change across the API layer and
belongs to whoever owns it, not to a test re-green. Using a DIFFERENT constant for them keeps the gap
visible in the assertions instead of letting one loose matcher hide it — if a route is later moved onto
`api()`, its test fails and points at this note.
*/

/** Shape sent by api-layer functions that call `fetch()` directly, bypassing `api()`. */
export const API_JSON_HEADERS_NO_ATTRIBUTION = {
  "Content-Type": "application/json",
} as const;
