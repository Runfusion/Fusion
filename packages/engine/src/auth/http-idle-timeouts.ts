/**
 * FNXC:CustomProviderHttpTimeout 2026-08-24-13:54:
 * Layer 2 of the per-model HTTP timeout: the engine-installed global undici dispatcher with
 * PER-ORIGIN body/headers idle timeouts. The classic 5-minute stop for local slow models has
 * two parallel 300s layers — the OpenAI SDK per-request TTFB timeout (layer 1, applied per
 * session via the engine's in-memory pi SettingsManager in pi.ts) and Node's default undici
 * dispatcher, whose `headersTimeout` (request -> first header byte) and `bodyTimeout` (idle
 * between body chunks) both default to 300s. Layer 1 cannot raise the undici layer: the SDK
 * aborts cleanly on its own timer, so a body that goes silent mid-stream for >300s still dies
 * with "Request timed out." even when the SDK timeout is disabled.
 *
 * This module mirrors pi's `configureHttpDispatcher` (pi-coding-agent dist/core/http-dispatcher.js)
 * but takes a per-origin timeout map instead of one global value, because undici timeouts are
 * per-origin and cannot be made per-model at the socket layer. `buildHttpIdleTimeoutMap`
 * collapses the custom providers' per-model `timeoutSeconds` onto `new URL(baseUrl).origin`:
 *  - the MOST PERMISSIVE value wins on a shared origin (a slow local model and a normal cloud
 *    model behind the same baseUrl must not have one model's short timeout kill the other);
 *  - `0` (disabled) is the most permissive value and beats any positive value on that origin;
 *  - origins with no configured timeout keep the 300s default (unlisted origins never change).
 * undici semantics (verified in undici 8.9.0 lib/dispatcher/client-h1.js, `if (delay)` guard):
 * `bodyTimeout: 0` / `headersTimeout: 0` install NO timer (disabled), matching the user-facing
 * `timeoutSeconds: 0 = off` contract. A positive value is an IDLE bound (it resets on every
 * streamed chunk), never a total-response cap.
 *
 * FNXC:CustomProviderHttpTimeout 2026-08-24-16:20:
 * Precision note (verified empirically on undici 8.9.0): the headers/body idle timers run on
 * undici's fast-timer implementation (lib/util/timers.js, TICK_MS=499ms / RESOLUTION_MS=1000ms)
 * — a sub-~1s configured value still only fires after ~2 ticks (≈1000ms), and realistic
 * multi-minute values carry at most ~500ms of error. This is the SAME timer class Node's own
 * default 300s idle timeout uses, so the per-model values get identical precision semantics;
 * do not market sub-second granularity in docs/UI. The fetch-visible failure is a `TypeError`
 * whose real `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` code lives on `err.cause`.
 *
 * Install points: `seedDashboardProviders` (startup, after custom-provider registration) and
 * the `settings:updated` listener there (provider save/reorder), so the map always tracks the
 * persisted custom providers. Swapping the global dispatcher takes effect on the next
 * connection; in-flight connections finish under the previous dispatcher, which is the same
 * best-effort semantics pi itself accepts for its own CLI dispatcher.
 */
import { EventEmitter } from "node:events";
import * as undici from "undici";

/** Default idle bound: today's Node/undici 300s behavior, applied to unlisted origins. */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
/** Node's 250ms default can terminate valid connection attempts on high-latency routes (mirrors pi). */
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

type ProviderLike = {
  baseUrl?: string;
  models?: Array<{ timeoutSeconds?: number }> | undefined;
};

/**
 * FNXC:CustomProviderHttpTimeout 2026-08-24-13:54:
 * Collapse per-model timeoutSeconds onto request origins. Returns a map of origin -> idle
 * timeout in ms (0 = disabled). Providers with an invalid baseUrl or no valid
 * `timeoutSeconds` model entries contribute nothing; their origins keep the default.
 */
export function buildHttpIdleTimeoutMap(
  providers: readonly ProviderLike[] | undefined | null,
): Map<string, number> {
  const timeoutsByOrigin = new Map<string, number>();

  for (const provider of providers ?? []) {
    let origin: string;
    try {
      const parsed = new URL(provider.baseUrl ?? "");
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        continue;
      }
      origin = parsed.origin;
    } catch {
      continue;
    }

    const modelTimeouts = (provider.models ?? [])
      .map((model) => model?.timeoutSeconds)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
    if (modelTimeouts.length === 0) {
      continue;
    }

    const current = timeoutsByOrigin.get(origin);
    const disabled = current === 0 || modelTimeouts.includes(0);
    const value = disabled
      ? 0
      : Math.max(current ?? 0, ...modelTimeouts.map((seconds) => Math.floor(seconds * 1000)));
    timeoutsByOrigin.set(origin, value);
  }

  return timeoutsByOrigin;
}

// Undici can emit an internal Client "error" while terminating a mid-stream fetch body.
// The body stream still rejects through reader.read(); this listener only prevents
// EventEmitter's unhandled "error" special case from crashing the engine (mirrors pi).
const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// FNXC:CustomProviderHttpTimeout 2026-08-24-15:02:
// Typing mirrors pi's http-dispatcher.ts exactly: undici's Dispatcher type only exposes
// typed overloads for connect/disconnect/connectionError/drain (no "error"), and undici 8.9.0
// exports no top-level ClientOptions type (it is Client.Options / Pool.Options). The error
// listener therefore goes through EventEmitter.prototype.on.call, and the options parameters
// are typed `object` with narrow casts at the constructor call sites.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }
  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: createUndiciClient,
    }),
  );
}

/**
 * FNXC:CustomProviderHttpTimeout 2026-08-24-13:54:
 * Build the per-origin dispatcher WITHOUT installing it, so tests can drive undici.fetch with
 * an explicit `{ dispatcher }` and assert the timeout behavior without touching the process
 * global. `timeoutMsByOrigin.get(origin) ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS` resolves every origin,
 * so unlisted origins keep the classic 300s default.
 */
export function buildHttpIdleDispatcher(timeoutMsByOrigin: ReadonlyMap<string, number>): undici.EnvHttpProxyAgent {
  // The per-origin factory overrides the agent-level defaults for every listed origin;
  // unlisted origins fall back to the classic 300s default (never change by accident).
  const factory = (origin: string | URL, options: object): undici.Dispatcher => {
    const timeoutMs = timeoutMsByOrigin.get(origin.toString()) ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
    return createUndiciOriginDispatcher(origin, {
      ...options,
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
    });
  };

  return withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      // Agent-level defaults; the per-origin factory overrides both for listed origins.
      bodyTimeout: DEFAULT_HTTP_IDLE_TIMEOUT_MS,
      connect: {
        autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
      },
      headersTimeout: DEFAULT_HTTP_IDLE_TIMEOUT_MS,
      clientFactory: createUndiciClient,
      factory,
    }),
  );
}

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

/**
 * FNXC:CustomProviderHttpTimeout 2026-08-24-13:54:
 * Install the per-origin dispatcher as the process global. Mirrors pi's `configureHttpDispatcher`
 * install semantics, including the `undici.install()` guard: keep fetch and the dispatcher on the
 * same undici implementation, and preserve a caller's deliberate fetch override.
 */
export function applyHttpIdleTimeouts(timeoutMsByOrigin: ReadonlyMap<string, number> = new Map()): undici.EnvHttpProxyAgent {
  const dispatcher = buildHttpIdleDispatcher(timeoutMsByOrigin);
  undici.setGlobalDispatcher(dispatcher);

  // Keep fetch and the dispatcher on the same undici implementation. Node's bundled fetch can
  // otherwise consume compressed responses through npm undici's dispatcher without decompressing
  // them. If a caller replaced fetch after module load, preserve that deliberate override.
  const shouldInstallGlobals =
    installedGlobalFetch === undefined
      ? globalThis.fetch === originalGlobalFetch
      : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    undici.install?.();
    installedGlobalFetch = globalThis.fetch;
  }

  return dispatcher;
}
