/*
FNXC:Telemetry 2026-06-16-09:44:
U10 OTLP exporter (PR #1683): export Command Center analytics as OTLP/HTTP JSON to an external collector. Must be OFF by default (no endpoint → nothing starts) and reject non-https endpoints in production; deliberately avoids the heavy @opentelemetry SDK in favor of a minimal, collector-compatible POST.
*/

/**
 * OpenTelemetry (OTLP) metrics exporter wiring (U10) — dashboard side.
 *
 * Periodically maps the Command Center analytics (tokens / cost / activity) to
 * OTLP/HTTP JSON via the pure `mapAnalyticsToOtlp` mapping in `@fusion/core`,
 * then POSTs them to a configured collector. **Disabled by default** — nothing
 * starts unless an endpoint is explicitly configured.
 *
 * SDK choice (changeset note): this is a **minimal OTLP/HTTP JSON exporter**, not
 * the full `@opentelemetry/*` SDK. The OTLP/HTTP JSON protocol is a single,
 * stable `POST /v1/metrics` of a well-defined JSON envelope (produced in core),
 * so for a default-disabled feature we avoid pulling the multi-package SDK
 * (sdk-metrics + exporter-metrics-otlp-http + resources + api). The wire shape is
 * collector-compatible; swapping in the official SDK later is mechanical.
 *
 * Security:
 *  - Endpoint is validated on write. In production (`NODE_ENV === "production"`)
 *    a non-`https:` endpoint is rejected (exporter does not start). Outside
 *    production an `http://` endpoint is allowed but warns loudly.
 *  - Auth headers (Datadog/Grafana/etc. tokens) are held in memory only; their
 *    values are NEVER logged. Header NAMES may appear in diagnostics; header
 *    VALUES are redacted via `redactSecrets` + an explicit value mask.
 *  - Collector-unreachable failures log (redacted) and back off exponentially;
 *    they never throw out of the interval, never crash the server, never block
 *    a request (the export runs on its own timer).
 */

import type { TaskStore } from "@fusion/core";
import { aggregateTokenAnalytics, aggregateActivityAnalytics, mapAnalyticsToOtlp } from "@fusion/core";
import { redactSecrets } from "@fusion/core";
import { requireAsyncLayer } from "./require-async-layer.js";
import type { RuntimeLogger } from "./runtime-logger.js";

/** Resolved, validated exporter configuration. */
export interface OtelExporterConfig {
  /** Full OTLP/HTTP metrics endpoint, e.g. `https://collector:4318/v1/metrics`. */
  endpoint: string;
  /** Auth + other headers to send (values are secret-class — never logged). */
  headers: Record<string, string>;
  /** Export interval in ms. */
  intervalMs: string extends never ? never : number;
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /** Resource attributes (e.g. service.name). */
  resourceAttributes: Record<string, string>;
}

/** Minimum/maximum bounds for the export interval (ms). */
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Backoff bounds for an unreachable collector. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;

/** A single redacted header key (value masked) for diagnostics. */
const HEADER_VALUE_MASK = "[REDACTED]";

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production";
}

/**
 * Parse `key=value,key2=value2` header / attribute lists (the OTEL convention).
 * Whitespace around keys/values is trimmed; malformed pairs are skipped.
 */
export function parseKeyValueList(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function clampInterval(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, value));
}

/**
 * Resolve exporter config from environment. Returns `null` (disabled) when no
 * endpoint is configured, OR when the endpoint fails production https validation
 * (the caller logs the rejection). This is the **disabled-by-default** gate:
 * `FUSION_OTEL_METRICS_ENDPOINT` must be explicitly set to enable.
 *
 * Recognized env:
 *  - `FUSION_OTEL_METRICS_ENDPOINT` — full `/v1/metrics` URL (required to enable)
 *  - `FUSION_OTEL_METRICS_HEADERS`  — `key=value,key2=value2` auth headers
 *  - `FUSION_OTEL_METRICS_INTERVAL_MS` — export interval (default 60_000)
 *  - `FUSION_OTEL_METRICS_TIMEOUT_MS`  — per-request timeout (default 10_000)
 *  - `FUSION_OTEL_RESOURCE_ATTRIBUTES` — `key=value,...` resource attributes
 */
export function resolveOtelExporterConfig(
  env: NodeJS.ProcessEnv = process.env,
):
  | { kind: "disabled" }
  | { kind: "rejected"; reason: string; endpoint: string }
  | { kind: "enabled"; config: OtelExporterConfig; warnHttp: boolean } {
  const endpoint = env.FUSION_OTEL_METRICS_ENDPOINT?.trim();
  if (!endpoint) return { kind: "disabled" };

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { kind: "rejected", reason: "endpoint is not a valid URL", endpoint };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      kind: "rejected",
      reason: `unsupported protocol "${url.protocol}" (only http/https)`,
      endpoint,
    };
  }

  const isHttp = url.protocol === "http:";
  if (isHttp && isProduction(env)) {
    return {
      kind: "rejected",
      reason: "http:// endpoints are not allowed in production (use https://)",
      endpoint,
    };
  }

  const intervalMs = clampInterval(
    env.FUSION_OTEL_METRICS_INTERVAL_MS
      ? Number.parseInt(env.FUSION_OTEL_METRICS_INTERVAL_MS, 10)
      : undefined,
  );
  const timeoutRaw = env.FUSION_OTEL_METRICS_TIMEOUT_MS
    ? Number.parseInt(env.FUSION_OTEL_METRICS_TIMEOUT_MS, 10)
    : undefined;
  const timeoutMs =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? timeoutRaw
      : DEFAULT_TIMEOUT_MS;

  const headers = parseKeyValueList(env.FUSION_OTEL_METRICS_HEADERS);
  const resourceAttributes = {
    "service.name": "fusion-dashboard",
    ...parseKeyValueList(env.FUSION_OTEL_RESOURCE_ATTRIBUTES),
  };

  return {
    kind: "enabled",
    warnHttp: isHttp,
    config: {
      endpoint,
      headers,
      intervalMs: intervalMs as OtelExporterConfig["intervalMs"],
      timeoutMs,
      resourceAttributes,
    },
  };
}

/** Diagnostic-safe view of headers: keys preserved, values masked + redacted. */
export function redactHeadersForDiagnostics(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(headers)) {
    // Never surface the value; mask it. The key alone (e.g. "DD-API-KEY") is
    // safe and useful for debugging which auth scheme is configured.
    out[key] = HEADER_VALUE_MASK;
  }
  return out;
}

/** Minimal fetch-like signature so tests can inject a collector stub. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text?: () => Promise<string> }>;

export interface OtelExporterDeps {
  store: TaskStore;
  config: OtelExporterConfig;
  logger: RuntimeLogger;
  /** Injectable fetch (defaults to global `fetch`). */
  fetchImpl?: FetchLike;
  /** Injectable clock for `timeUnixNano` (defaults to `Date.now`). */
  now?: () => number;
}

/**
 * A running OTLP metrics exporter. Holds an interval that maps current analytics
 * and POSTs them. `stop()` clears the timer and any in-flight backoff.
 */
export interface OtelExporterHandle {
  /** Run a single export now (used by tests; the timer calls this internally). */
  exportOnce(): Promise<void>;
  /** Stop the periodic exporter and release the timer. */
  stop(): void;
}

/**
 * Start the periodic OTLP metrics exporter. The caller is responsible for only
 * invoking this when {@link resolveOtelExporterConfig} returned `enabled`.
 *
 * The export is wrapped so a collector failure logs (redacted) and backs off
 * exponentially without ever throwing out of the timer.
 */
export function startOtelExporter(deps: OtelExporterDeps): OtelExporterHandle {
  const { store, config, logger } = deps;
  const fetchImpl: FetchLike =
    deps.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
  const now = deps.now ?? Date.now;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;

  const log = logger.child("otel-exporter");

  function backoffMs(): number {
    if (consecutiveFailures === 0) return config.intervalMs;
    const backoff = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1),
    );
    // Back off, but never poll faster than the configured interval.
    return Math.max(config.intervalMs, backoff);
  }

  async function exportOnce(): Promise<void> {
    // Mapping + DB read are guarded so a malformed snapshot never throws out.
    let body: string;
    try {
      /* FNXC:PostgresSatelliteCutover 2026-07-14-17:30: OTLP exports read the authoritative PostgreSQL analytics layer and never reopen SQLite. */
      const dbOrLayer = requireAsyncLayer(store, "OTLP analytics exporter");
      const tokens = await aggregateTokenAnalytics(dbOrLayer, { groupBy: "model", now: now() });
      const activity = await aggregateActivityAnalytics(dbOrLayer, {});
      const nowMs = now();
      const payload = mapAnalyticsToOtlp({
        tokens,
        activity,
        timeUnixNano: String(nowMs * 1_000_000),
        resourceAttributes: config.resourceAttributes,
      });
      body = JSON.stringify(payload);
    } catch (err) {
      log.error("Failed to compose OTLP metrics payload", {
        message: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    timeout.unref?.();
    try {
      const res = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...config.headers },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        consecutiveFailures += 1;
        log.warn("OTLP collector returned a non-2xx status; backing off", {
          status: res.status,
          consecutiveFailures,
          // Never log header values; keys only.
          headers: redactHeadersForDiagnostics(config.headers),
        });
        return;
      }
      if (consecutiveFailures > 0) {
        log.info("OTLP collector reachable again; resuming normal interval", {
          afterFailures: consecutiveFailures,
        });
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      log.warn("OTLP collector unreachable; backing off", {
        message: redactSecrets(err instanceof Error ? err.message : String(err)),
        consecutiveFailures,
        headers: redactHeadersForDiagnostics(config.headers),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void exportOnce().finally(scheduleNext);
    }, backoffMs());
    timer.unref?.();
  }

  log.info("OTLP metrics exporter started", {
    // Endpoint is config (not a secret); headers are masked.
    endpoint: config.endpoint,
    intervalMs: config.intervalMs,
    headers: redactHeadersForDiagnostics(config.headers),
  });

  // First export after one interval (don't block startup).
  scheduleNext();

  return {
    exportOnce,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Convenience wrapper: resolve config from env and, when enabled+valid, start
 * the exporter. Returns the handle, or `null` when disabled/rejected (logging
 * the rejection). Safe to call unconditionally from server startup — it is a
 * no-op unless `FUSION_OTEL_METRICS_ENDPOINT` is set.
 */
export function maybeStartOtelExporter(args: {
  store: TaskStore;
  logger: RuntimeLogger;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => number;
}): OtelExporterHandle | null {
  const log = args.logger.child("otel-exporter");
  const resolved = resolveOtelExporterConfig(args.env ?? process.env);
  if (resolved.kind === "disabled") {
    return null;
  }
  if (resolved.kind === "rejected") {
    log.warn("OTLP metrics exporter NOT started (invalid endpoint)", {
      endpoint: resolved.endpoint,
      reason: resolved.reason,
    });
    return null;
  }
  if (resolved.warnHttp) {
    log.warn(
      "OTLP metrics endpoint uses http:// — auth tokens will be sent UNENCRYPTED. " +
        "Use https:// in any non-local deployment.",
      { endpoint: resolved.config.endpoint },
    );
  }
  return startOtelExporter({
    store: args.store,
    config: resolved.config,
    logger: args.logger,
    fetchImpl: args.fetchImpl,
    now: args.now,
  });
}
