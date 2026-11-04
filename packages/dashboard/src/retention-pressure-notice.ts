/*
FNXC:RetentionPressureNotice 2026-09-23-18:55:
RUFU-257: the operator-facing half of the retention instrument. Between 2026-09-15 and 2026-09-17 the
dashboard OOM-crashed seven times while the heap climbed 1.5–2 GB/h, and the operator learned about it
only from a crash — `/metrics` had no in-process cache accounting at all, and nothing in the process
ever said "this is getting large". The census (`lib/retention-census.ts`) plus the retention sampler
(`metrics/retention-sampler.ts`) now attribute bytes per cache and decide when the pile-up is real
(`evaluatePressure`); this module is what that decision DOES, so the signal reaches a human before the
process dies rather than in a post-mortem.

CHANNEL — reuse, never invent. The pressure decision arrives as a `RetentionPressureSignal` from the
sampler tick. Two sinks, both pre-existing:
  1. the dashboard runtime log (`runtime-logger.ts`), so the pressure episode is in the same log stream
     an operator already tails;
  2. the operator mailbox, written through `MessageStore.sendMessageOnce` — the SAME one-shot system-notice
     seam `core/task-delete-notice.ts` and the wedge/approval notifications use. There is deliberately no
     new notification channel, no new SSE event type, and no dashboard-app rendering change here: the
     dashboard cannot import `@fusion/engine` (circularity rule), so the engine's `NotificationService` is
     reached only structurally through the message store the engine already exposes via
     `engine.getMessageStore()`.

RATE LIMITING is layered, because a stalled pile-up must never become a firehose:
  - the sampler's own `pressureCooldownMs` (default 10 min) gates how often ANY signal is emitted;
  - this module additionally makes the MAILBOX write idempotent per (reason, UTC bucket) — default one
    bucket per day — so a pressure episode that spans days re-announces itself daily and no louder, and a
    duplicate or concurrent write collapses in the DB's conflict handling exactly like the delete notice.

PAYLOAD HONESTY: the log context and message metadata carry the fixed reason enum, registered source ids,
and byte/ratio numbers only — never heap contents, cache keys, or request data. Prose exists only in the
mailbox `content` field (the delete-notice convention). The MessageStore itself sanitizes control
characters on write; nothing here writes to run-audit (FN-7158/FN-9175 reserve audit rows for
ids/counts/outcomes, and census numbers are explicitly excluded from it).

BEST-EFFORT: memory telemetry must never become a lifecycle dependency. `notifyRetentionPressure` never
throws and never rejects, and the notifier wrapper fires it without awaiting, so a missing, throwing, or
slow mailbox cannot stall or fail the census tick that was trying to report the problem.
*/

import { DASHBOARD_USER_ID, type MessageCreateInput } from "@fusion/core";
import { formatBytes } from "./lib/format-bytes.js";
import type { RuntimeLogger } from "./runtime-logger.js";
import type { RetentionPressureSignal } from "./metrics/retention-sampler.js";

/**
 * The one mailbox method this notice needs. `MessageStore` structurally satisfies it and a test fake
 * is two lines — the same narrowing `core/task-delete-notice.ts` applies, because the dashboard must
 * not depend on the whole store surface for a single system notice.
 */
export interface RetentionPressureMailbox {
  sendMessageOnce(
    input: MessageCreateInput,
    idempotencyKey: string,
  ): Promise<{ inserted?: boolean } | unknown>;
}

/** Idempotency bucket width for the mailbox notice: one notice per reason per bucket. */
export const RETENTION_PRESSURE_NOTICE_BUCKET_MS = 24 * 60 * 60 * 1000;

export interface RetentionPressureNotifierInit {
  /** Where the warning line goes (the dashboard runtime log in production). */
  logger: Pick<RuntimeLogger, "warn">;
  /**
   * Resolved lazily: `createServer()` builds the sampler before the engine attaches its message
   * store, so the lookup must happen at signal time, not at construction time. Returning
   * undefined (headless server, no engine) degrades to log-line-only — losing a notice is
   * acceptable, blocking the census tick is not.
   */
  resolveMailbox?: () => RetentionPressureMailbox | undefined | null;
  /** Override for tests; defaults to {@link RETENTION_PRESSURE_NOTICE_BUCKET_MS}. */
  noticeBucketMs?: number;
}

/*
FNXC:HeapCeilingObservability 2026-10-01-10:56 (RUFU-462): the byte formatter moved to `lib/format-bytes.ts`
so the heap-ceiling notices render the SAME ceiling this notice already quotes as "% of <ceiling>".
*/

/** The share of the heap ceiling in use, as a percentage string; "unknown" when the limit is unreadable. */
function formatHeapShare(signal: RetentionPressureSignal): string {
  if (signal.heapLimitBytes <= 0) return "unknown share";
  return `${Math.round((signal.heapUsedBytes / signal.heapLimitBytes) * 100)}% of ${formatBytes(signal.heapLimitBytes)}`;
}

/**
 * The numeric context attached to the warning log line: fixed reason enum, registered source ids and
 * numbers. Named separately so a test can assert the field set without parsing prose.
 */
export function buildRetentionPressureLogContext(
  signal: RetentionPressureSignal,
): Record<string, number | string | null> {
  return {
    reason: signal.reason,
    topSourceId: signal.topSourceId,
    topSourceBytes: signal.topSourceBytes,
    atCeilingStreak: signal.atCeilingStreak,
    trackedBytes: signal.trackedBytes,
    heapUsedBytes: signal.heapUsedBytes,
    heapLimitBytes: signal.heapLimitBytes,
    coverageRatio: signal.coverageRatio,
  };
}

/** The one-line warning text. It names the largest retained source, which is the actionable half. */
export function buildRetentionPressureLogMessage(signal: RetentionPressureSignal): string {
  const leader = signal.topSourceId
    ? `largest retained source \`${signal.topSourceId}\` at ${formatBytes(signal.topSourceBytes)}`
    : "no census source has reported bytes yet";
  const detail =
    signal.reason === "source-at-ceiling"
      ? `${signal.atCeilingStreak} consecutive samples at a declared ceiling`
      : `heap at ${formatHeapShare(signal)}`;
  return `retention pressure (${signal.reason}): ${detail}; ${leader}; census covers ${(signal.coverageRatio * 100).toFixed(1)}% of used heap (${formatBytes(signal.trackedBytes)} tracked). See /metrics and docs/solutions/performance/dashboard-heap-growth-runbook.md`;
}

/** Operator-facing mailbox prose. Lives in the mailbox row only — never in run-audit. */
export function buildRetentionPressureNoticeContent(signal: RetentionPressureSignal): string {
  const when = new Date(signal.observedAtMs || Date.now()).toISOString();
  const leader = signal.topSourceId
    ? `The largest retained structure is \`${signal.topSourceId}\`, holding ${formatBytes(signal.topSourceBytes)}.`
    : "No individual census source had reported bytes at the moment this fired, so the growth sits outside the registered caches.";
  const cause =
    signal.reason === "source-at-ceiling"
      ? `A registered cache has sat at its declared ceiling for ${signal.atCeilingStreak} consecutive 5-second samples, which means it is evicting as fast as it is being written.`
      : `Used heap has reached ${formatHeapShare(signal)} of the process ceiling.`;
  return [
    `**Dashboard memory pressure** — ${signal.reason} (${when}).`,
    "",
    cause,
    leader,
    `The retention census accounts for ${formatBytes(signal.trackedBytes)} of ${formatBytes(signal.heapUsedBytes)} used heap (${(signal.coverageRatio * 100).toFixed(1)}%).`,
    "",
    "What to do: open `/metrics` and read `fusion_retention_coverage_ratio` first, then the",
    "`fusion_retention_source_bytes` series to see which cache dominates. The triage order, the",
    "meaning of each gauge, and the honest residual (heap the census cannot explain) are in",
    "`docs/solutions/performance/dashboard-heap-growth-runbook.md`.",
    "",
    "This is a warning, not an intervention: nothing was dropped, restarted, or resized to produce it.",
  ].join("\n");
}

/**
 * Deterministic idempotency key: one mailbox notice per reason per UTC bucket. A reason class is a
 * distinct operator decision ("the heap is nearly full" vs "a cache is pinned at its ceiling"), so
 * collapsing them into one key would let the louder-but-earlier reason silence the other; a bucket is
 * coarse enough that a sustained episode announces itself once a day and no louder.
 */
export function buildRetentionPressureNoticeIdempotencyKey(
  signal: RetentionPressureSignal,
  bucketMs: number = RETENTION_PRESSURE_NOTICE_BUCKET_MS,
): string {
  const at = signal.observedAtMs || Date.now();
  const bucket = Math.floor(at / Math.max(1, bucketMs));
  return `retention-pressure:${signal.reason}:${bucket}`;
}

/**
 * Write the operator notice. NEVER throws and NEVER rejects: it resolves to whether a mailbox row was
 * actually written, purely so callers and tests can assert the invariant. A headless dashboard (no
 * engine message store) resolves false — the log line still fired.
 */
export async function notifyRetentionPressure(
  signal: RetentionPressureSignal,
  deps: { mailbox?: RetentionPressureMailbox | null; noticeBucketMs?: number },
): Promise<boolean> {
  try {
    if (!deps.mailbox) return false;
    await deps.mailbox.sendMessageOnce(
      {
        fromId: "system",
        fromType: "system",
        toId: DASHBOARD_USER_ID,
        toType: "user",
        type: "system",
        content: buildRetentionPressureNoticeContent(signal),
        // Ids/enums/numbers only — the prose is the `content` field, never the metadata.
        metadata: {
          kind: "retention-pressure-notice",
          reason: signal.reason,
          topSourceId: signal.topSourceId,
          topSourceBytes: signal.topSourceBytes,
          atCeilingStreak: signal.atCeilingStreak,
          trackedBytes: signal.trackedBytes,
          heapUsedBytes: signal.heapUsedBytes,
          heapLimitBytes: signal.heapLimitBytes,
          coverageRatio: signal.coverageRatio,
        },
      },
      buildRetentionPressureNoticeIdempotencyKey(signal, deps.noticeBucketMs),
    );
    return true;
  } catch {
    // Swallowed on purpose: the pressure notice is telemetry about a degraded process, and a
    // failing notice must not degrade the process further.
    return false;
  }
}

/**
 * Build the sink handed to `createMetricsSampler({ retention: { onPressure } })`. Synchronous and
 * never throwing: the mailbox write is fired without awaiting, because the caller is the census tick
 * that must keep reporting regardless of mailbox health.
 */
export function createRetentionPressureNotifier(
  init: RetentionPressureNotifierInit,
): (signal: RetentionPressureSignal) => void {
  const bucketMs = init.noticeBucketMs ?? RETENTION_PRESSURE_NOTICE_BUCKET_MS;
  return (signal) => {
    try {
      init.logger.warn(buildRetentionPressureLogMessage(signal), buildRetentionPressureLogContext(signal));
    } catch {
      /* a failing log sink must not stop the notice */
    }
    let mailbox: RetentionPressureMailbox | undefined | null = null;
    try {
      mailbox = init.resolveMailbox?.();
    } catch {
      mailbox = null;
    }
    void notifyRetentionPressure(signal, { mailbox, noticeBucketMs: bucketMs });
  };
}
