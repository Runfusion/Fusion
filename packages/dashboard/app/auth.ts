/**
 * Dashboard authentication: token capture, storage, and injection.
 *
 * Flow:
 *   1. On first load, if `?token=<value>` is present in the URL, capture it,
 *      store it in localStorage, and strip it from the visible URL so the
 *      secret doesn't end up in browser history or shared screenshots.
 *   2. `getAuthToken()` returns the stored token (or undefined if none).
 *   3. `installAuthFetch()` wraps `window.fetch` to inject
 *      `Authorization: Bearer <token>` on same-origin `/api/*` calls.
 *   4. `appendTokenQuery()` is for browser transports that cannot set headers
 *      (`EventSource`, `WebSocket`, popup navigation, `sendBeacon`, links/imgs).
 *
 * Safe token propagation rules:
 *   - Header-based requests should prefer `Authorization` (via fetch wrapper or
 *     `withTokenHeader`). `withTokenHeader` is idempotent and never overwrites
 *     an explicitly supplied `Authorization` value.
 *   - Query-token fallback (`fn_token`) is only appended for dashboard-owned
 *     URLs (same host/port and same protocol family, including http↔ws and
 *     https↔wss pairs). Cross-origin URLs are returned unchanged so daemon
 *     tokens are never leaked to third-party providers.
 *
 * If no token is configured (dashboard started with `--no-auth`), all helpers
 * become no-ops.
 */

const STORAGE_KEY = "fn.authToken";
const URL_PARAM = "token";
/** Query param name used when we can't set an Authorization header (EventSource, WebSocket). */
export const QUERY_TOKEN_PARAM = "fn_token";

let cachedToken: string | undefined;
let captureAttempted = false;
let daemonAuthFailureSignaled = false;

/**
 * Browser event fired when the dashboard API returns the daemon-auth 401 payload,
 * indicating the current browser token is missing/invalid and user recovery is required.
 */
export const AUTH_TOKEN_RECOVERY_REQUIRED_EVENT = "fn:auth-token-recovery-required";

interface DaemonUnauthorizedPayload {
  error?: unknown;
  message?: unknown;
}

function readStoredToken(): string | undefined {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredToken(token: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Private mode / storage disabled — fall through; token stays in memory.
  }
}

/**
 * Read the `?token=...` param off the current URL (if present) and stash it
 * into localStorage, then remove it from the visible URL so the secret is not
 * retained in browser history. Returns the token if one was captured.
 *
 * Safe to call multiple times — only the first call does work.
 */
function captureTokenFromUrl(): string | undefined {
  if (captureAttempted || typeof window === "undefined") {
    return undefined;
  }
  captureAttempted = true;

  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get(URL_PARAM);
    if (!token) {
      return undefined;
    }

    writeStoredToken(token);
    url.searchParams.delete(URL_PARAM);
    const cleaned = url.pathname + (url.search ? url.search : "") + url.hash;
    window.history.replaceState(window.history.state, "", cleaned);
    return token;
  } catch {
    return undefined;
  }
}

/** Return the bearer token in effect for this session, if any. */
export function getAuthToken(): string | undefined {
  if (cachedToken !== undefined) {
    return cachedToken;
  }
  const captured = captureTokenFromUrl();
  if (captured) {
    cachedToken = captured;
    return captured;
  }
  const stored = readStoredToken();
  if (stored) {
    cachedToken = stored;
    return stored;
  }
  return undefined;
}

/** Persist a token for future dashboard API requests in this browser session. */
export function setAuthToken(token: string): void {
  cachedToken = token;
  daemonAuthFailureSignaled = false;
  writeStoredToken(token);
}

/** Clear the stored token (e.g., on a 401 response). */
export function clearAuthToken(): void {
  cachedToken = undefined;
  daemonAuthFailureSignaled = false;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore — worst case, a stale token sits in memory until reload.
  }
}

function normalizeProtocol(protocol: string): string {
  if (protocol === "ws:") return "http:";
  if (protocol === "wss:") return "https:";
  return protocol;
}

function isSupportedTransportProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:" || protocol === "ws:" || protocol === "wss:";
}

function isDashboardOwnedUrl(url: URL): boolean {
  if (typeof window === "undefined") return false;

  const current = new URL(window.location.origin);
  if (!isSupportedTransportProtocol(url.protocol)) {
    return false;
  }

  const sameHost = url.hostname === current.hostname;
  const samePort = url.port === current.port;
  const sameProtocolFamily = normalizeProtocol(url.protocol) === normalizeProtocol(current.protocol);

  return sameHost && samePort && sameProtocolFamily;
}

function parseTokenizableUrl(url: string): { parsed: URL; preserveRelativePath: boolean } | undefined {
  if (typeof window === "undefined") return undefined;

  try {
    const parsed = new URL(url, window.location.origin);
    const preserveRelativePath = url.startsWith("/");
    return { parsed, preserveRelativePath };
  } catch {
    return undefined;
  }
}

/**
 * Append `fn_token=<token>` for non-header browser transports.
 *
 * This is intentionally restricted to dashboard-owned URLs to prevent leaking
 * daemon auth secrets to third-party providers (for example OAuth hosts).
 */
export function appendTokenQuery(url: string): string {
  const token = getAuthToken();
  if (!token || typeof window === "undefined") {
    return url;
  }

  const parsed = parseTokenizableUrl(url);
  if (!parsed || !isDashboardOwnedUrl(parsed.parsed)) {
    return url;
  }

  parsed.parsed.searchParams.set(QUERY_TOKEN_PARAM, token);
  return parsed.preserveRelativePath
    ? `${parsed.parsed.pathname}${parsed.parsed.search}${parsed.parsed.hash}`
    : parsed.parsed.toString();
}

/** Merge an Authorization header onto an existing HeadersInit, if we have a token. */
export function withTokenHeader(init?: HeadersInit): HeadersInit | undefined {
  const token = getAuthToken();
  if (!token) {
    return init;
  }
  const headers = new Headers(init ?? {});
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

function isDaemonAuthUnauthorizedPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const candidate = payload as DaemonUnauthorizedPayload;
  return candidate.error === "Unauthorized" && candidate.message === "Valid bearer token required";
}

function emitDaemonAuthRecoverySignal(): void {
  if (typeof window === "undefined" || daemonAuthFailureSignaled) {
    return;
  }

  daemonAuthFailureSignaled = true;
  window.dispatchEvent(new CustomEvent(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT));
}

async function detectDaemonAuthFailure(response: Response): Promise<void> {
  if (response.status !== 401) {
    return;
  }

  try {
    const responseClone = response.clone();
    const contentType = responseClone.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return;
    }

    const payload = await responseClone.json();
    if (isDaemonAuthUnauthorizedPayload(payload)) {
      emitDaemonAuthRecoverySignal();
    }
  } catch {
    // If body parsing fails, leave response untouched for callers.
  }
}

/**
 * Monkey-patch `window.fetch` once so every same-origin `/api/*` request gets
 * a bearer token. This covers direct `fetch()` callers that don't route
 * through the `api()` helper without requiring us to touch each one.
 */
export function installAuthFetch(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- property sentinel on global window object, no better type exists
  if (typeof window === "undefined" || (window as any).__fnAuthFetchInstalled) {
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- property sentinel on global window object, no better type exists
  (window as any).__fnAuthFetchInstalled = true;

  // Ensure token is captured-from-URL before the first fetch fires.
  getAuthToken();

  const originalFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const token = getAuthToken();

    const urlString = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    // Only attach the token and watch for daemon auth failures on same-origin /api/* requests.
    const isApiCall = (() => {
      try {
        const resolved = new URL(urlString, window.location.origin);
        if (resolved.origin !== window.location.origin) return false;
        return resolved.pathname.startsWith("/api/") || resolved.pathname === "/api";
      } catch {
        return urlString.startsWith("/api/") || urlString === "/api";
      }
    })();

    if (!isApiCall) {
      return originalFetch(input, init);
    }

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    return originalFetch(input, { ...init, headers }).then((response) => {
      void detectDaemonAuthFailure(response);
      return response;
    });
  };
}
