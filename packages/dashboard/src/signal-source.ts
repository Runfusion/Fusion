import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * U11 — External signal ingestion seam.
 *
 * This module defines the common `SignalSource` adapter interface plus the
 * shared security primitives (HMAC verification, replay window, nonce dedup,
 * body-size cap, field-length caps, SSRF-untrusted URL handling) that every
 * provider adapter reuses. It mirrors the GitHub ingestion path
 * (`github-webhooks.ts`) which also lives in `packages/dashboard/src`.
 *
 * Scope discipline (per the plan): the generic webhook adapter is the
 * must-work path. Sentry/Datadog/PagerDuty are thin adapters that supply
 * provider-specific HMAC verification + payload normalization. We deliberately
 * keep the registry thin — adapters are looked up by a small map, no heavy
 * abstraction until more providers exist.
 */

/** Normalized severity for an ingested signal. */
export type SignalSeverity = "critical" | "error" | "warning" | "info";

/** Supported external signal providers. */
export type SignalProvider = "sentry" | "datadog" | "pagerduty" | "webhook";

/**
 * Field-length caps applied to every normalized {@link Signal} before it is
 * turned into a task. External input is never trusted — caps bound storage and
 * prevent abuse via oversized fields.
 */
export const SIGNAL_FIELD_CAPS = {
  title: 300,
  body: 8_000,
  /** Cap on the serialized `meta` JSON (bytes). */
  metaBytes: 4_096,
  groupingKey: 256,
  link: 2_048,
} as const;

/** Maximum accepted request body size for any signal webhook (bytes, ~1 MB). */
export const SIGNAL_MAX_BODY_BYTES = 1_048_576;

/** Replay window: reject signed payloads whose timestamp is outside ±5 min. */
export const SIGNAL_REPLAY_WINDOW_MS = 5 * 60 * 1_000;

/**
 * A normalized external signal. Provider adapters map their native payloads
 * onto this shape. Downstream (U13 storm guard) groups re-firing signals by
 * {@link Signal.groupingKey}.
 */
export interface Signal {
  /** Source provider that produced this signal. */
  source: SignalProvider;
  /** Stable provider-specific external id (used for delivery dedup). */
  externalId: string;
  /**
   * Grouping primitive used by the storm guard to collapse re-firing signals
   * (Sentry issue.id, PagerDuty incident.id, Datadog monitor key). The generic
   * webhook requires the caller to supply one; otherwise it falls back to
   * `source + normalized-title` (see {@link fallbackGroupingKey}).
   */
  groupingKey: string;
  /** Short human-visible title. */
  title: string;
  /** Optional longer description / detail. */
  body?: string;
  /** Normalized severity. */
  severity: SignalSeverity;
  /**
   * Optional canonical URL back to the source. Treated as SSRF-untrusted: it is
   * stored as data and only rendered as an external link, never fetched server
   * side. See {@link isSafeExternalUrl}.
   */
  link?: string;
  /** Provider event timestamp (epoch ms), used for the replay window. */
  timestamp?: number;
  /**
   * Non-rendered descriptor data carried from the source. Stored as JSON data
   * only — never rendered as raw HTML in the dashboard. Capped to
   * {@link SIGNAL_FIELD_CAPS.metaBytes}.
   */
  meta?: Record<string, unknown>;
}

/** Context passed to an adapter's {@link SignalSource.verify}. */
export interface SignalVerifyContext {
  /** Raw request body bytes (required for HMAC). */
  rawBody: Buffer;
  /** Lower-cased request headers. */
  headers: Record<string, string | undefined>;
  /** Per-provider secret resolved from env / encrypted settings. */
  secret: string | undefined;
}

/** Result of an adapter's signature verification. */
export interface SignalVerifyResult {
  valid: boolean;
  /** HTTP status to return on failure (always 401 for auth failures). */
  status?: number;
  error?: string;
}

/**
 * A provider adapter. Kept intentionally thin: a mandatory `verify(ctx)` (HMAC)
 * plus a `normalize(payload)` that yields a {@link Signal} (or `null` for a
 * payload that is valid but not actionable, e.g. a ping/health event).
 */
export interface SignalSource {
  readonly provider: SignalProvider;
  /**
   * The env var name carrying this provider's HMAC secret. Secrets are NEVER
   * source-controlled; they come from the environment (or encrypted settings).
   */
  readonly secretEnvVar: string;
  /** Mandatory HMAC signature verification against a per-provider secret. */
  verify(ctx: SignalVerifyContext): SignalVerifyResult;
  /**
   * Normalize a parsed payload into a {@link Signal}. Throws (or returns null)
   * for malformed/non-actionable payloads — callers translate a throw into a
   * 4xx with no task created.
   */
  normalize(payload: unknown, ctx: SignalVerifyContext): Signal | null;
}

// ── Shared security helpers ────────────────────────────────────────────────

/**
 * Constant-time comparison of a computed HMAC against a provided signature.
 * `signatureHex` may carry a `sha256=` / `v1=` style prefix-stripped value.
 */
export function verifyHmacSignature(
  rawBody: Buffer,
  signatureHex: string | undefined,
  secret: string,
): boolean {
  if (!signatureHex) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (signatureHex.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signatureHex), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** True when the provider event timestamp is inside the replay window. */
export function isWithinReplayWindow(
  timestampMs: number | undefined,
  nowMs: number = Date.now(),
  windowMs: number = SIGNAL_REPLAY_WINDOW_MS,
): boolean {
  if (timestampMs === undefined || !Number.isFinite(timestampMs)) {
    // No timestamp → cannot bound replay; reject to stay safe.
    return false;
  }
  return Math.abs(nowMs - timestampMs) <= windowMs;
}

/**
 * In-memory delivery-id nonce store with TTL eviction. Used to reject replayed
 * deliveries (same external/delivery id) within the replay window. Mirrors the
 * spirit of `github-tracking-dedup.ts` for the inbound path.
 */
export class DeliveryNonceCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs: number = SIGNAL_REPLAY_WINDOW_MS) {}

  /** Returns true if this is a fresh delivery; false if a replay. */
  check(nonce: string, nowMs: number = Date.now()): boolean {
    this.evict(nowMs);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, nowMs);
    return true;
  }

  private evict(nowMs: number): void {
    for (const [key, ts] of this.seen) {
      if (nowMs - ts > this.ttlMs) this.seen.delete(key);
    }
  }

  /** Test/diagnostic helper. */
  size(): number {
    return this.seen.size;
  }
}

/**
 * Per-source sliding-window rate limiter (in-memory). Caps a flood of inbound
 * signals from a single provider.
 */
export class SignalRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly windowMs: number = 60_000,
    private readonly max: number = 120,
  ) {}

  /** Returns true if the request is allowed; false if over the cap. */
  allow(key: string, nowMs: number = Date.now()): boolean {
    const cutoff = nowMs - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(nowMs);
    this.hits.set(key, arr);
    return true;
  }
}

/**
 * SSRF guard for URLs found in payloads. We never fetch these URLs; this only
 * gates whether a link is safe to store/surface as an external link. Rejects
 * non-http(s) schemes and obvious internal/loopback/private hosts.
 */
export function isSafeExternalUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return false;
  }
  // IPv4 private / loopback / link-local ranges.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  return true;
}

/** Truncate a string to a cap, trimming whitespace. */
function capString(value: string, cap: number): string {
  const trimmed = value.trim();
  return trimmed.length > cap ? trimmed.slice(0, cap) : trimmed;
}

/** Normalize a title for the fallback grouping key (lower-case, collapsed). */
export function normalizeTitleForGrouping(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Generic-webhook grouping-key fallback: `source + normalized-title` when the
 * caller does not supply an explicit grouping key.
 */
export function fallbackGroupingKey(source: SignalProvider, title: string): string {
  return `${source}:${normalizeTitleForGrouping(title)}`;
}

/**
 * Apply field-length caps and meta-byte cap to a normalized signal. Drops a
 * `link` that is not an SSRF-safe external URL (kept as data only otherwise via
 * caller choice — here we drop unsafe links entirely). Returns a new object.
 */
export function applySignalCaps(signal: Signal): Signal {
  let meta = signal.meta;
  if (meta) {
    let serialized = "";
    try {
      serialized = JSON.stringify(meta);
    } catch {
      serialized = "";
    }
    if (!serialized || Buffer.byteLength(serialized, "utf8") > SIGNAL_FIELD_CAPS.metaBytes) {
      // Oversized or unserializable meta is dropped rather than truncated mid-JSON.
      meta = undefined;
    }
  }
  const link =
    signal.link && isSafeExternalUrl(signal.link)
      ? capString(signal.link, SIGNAL_FIELD_CAPS.link)
      : undefined;
  return {
    ...signal,
    title: capString(signal.title, SIGNAL_FIELD_CAPS.title) || "(untitled signal)",
    body: signal.body ? capString(signal.body, SIGNAL_FIELD_CAPS.body) : undefined,
    groupingKey: capString(signal.groupingKey, SIGNAL_FIELD_CAPS.groupingKey),
    link,
    meta,
  };
}
