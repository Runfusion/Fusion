import type { RunAuditEventInput } from "../types.js";
import { createLogger } from "../process/logger.js";
import { RUN_AUDIT_SINK_QUEUE_MAX } from "./audit-sink-writer.js";

export const CORE_RUN_AUDIT_EMIT_TIMEOUT_MS = 2_000;

/**
 * FNXC:RunAuditSink 2026-09-30 (RUFU-453):
 * What a buffered host reports back for one accepted row. `accepted` is the only question the seam asks:
 * true means the row is owned by the drain writer and will be written or spilled, so the caller may
 * return without having waited for a database round-trip.
 */
export type RunAuditBufferedSubmitResult = {
  accepted: boolean;
  queued: boolean;
  spilled: boolean;
  queueDepth: number;
};

export type RunAuditSinkHost = {
  recordRunAuditEvent?: (input: RunAuditEventInput) => unknown;
  /**
   * The drain writer below the sink boundary (`run-audit/audit-sink-writer.ts`). Present on a store
   * whose durable backend is reachable; absent on test doubles, on a SQLite host, and when
   * `FUSION_RUN_AUDIT_BUFFERED=0`, which restores the plain bounded direct write.
   */
  recordRunAuditEventBuffered?: (input: RunAuditEventInput) => RunAuditBufferedSubmitResult;
  /** Sink accounting, read only to attribute a timeout line to the queue that was standing behind it. */
  getRunAuditSinkStats?: () => { queueDepth?: number; batches?: number } | null;
} | null | undefined;

export type RunAuditLogger = { warn: (message: string) => void };

export type BoundedRunAuditResult =
  | { outcome: "recorded" }
  | { outcome: "absent" }
  | { outcome: "failed"; error: unknown }
  | { outcome: "timed-out" };

type RunAuditEvent = RunAuditEventInput | { mutationType: string; [key: string]: unknown };

const defaultLog = createLogger("run-audit");

/*
FNXC:RunAuditSink 2026-09-30 (RUFU-453):
Hand-off and fallback lines are rate-limited per source module because the incident this responds to was
1332 copies of one sentence. A queue that is merely working is not a log line per row; a queue that is
full, or a writer that refused a row, is worth one line per interval.
*/
const SINK_NOTICE_INTERVAL_MS = 60_000;
const SINK_NOTICE_KEYS_MAX = 200;
const lastSinkNoticeAtBySource = new Map<string, number>();

function sinkNoticeDue(source: string): boolean {
  const nowMs = Date.now();
  if ((lastSinkNoticeAtBySource.get(source) ?? 0) + SINK_NOTICE_INTERVAL_MS > nowMs) return false;
  // The key space is mutation-type shaped, but a `string & {}` escape hatch in the vocabulary means it
  // is not literally closed, so the throttle bounds itself rather than trusting the enum.
  if (lastSinkNoticeAtBySource.size >= SINK_NOTICE_KEYS_MAX) lastSinkNoticeAtBySource.clear();
  lastSinkNoticeAtBySource.set(source, nowMs);
  return true;
}

/**
 * Hands one fire-and-forget row to the drain writer when the host has one.
 *
 * Returns null when there is no writer to hand to, so the caller falls through to the bounded direct
 * write unchanged. A submit that throws synchronously is treated as "no writer" for this row rather
 * than as telemetry that may alter its caller: the direct bounded path still runs afterwards.
 */
export function submitRunAuditToSinkWriter(
  host: RunAuditSinkHost,
  event: RunAuditEvent,
  log: RunAuditLogger,
): "accepted" | "absent" {
  const submit = (host as { recordRunAuditEventBuffered?: (input: RunAuditEventInput) => RunAuditBufferedSubmitResult } | null | undefined)
    ?.recordRunAuditEventBuffered;
  if (typeof submit !== "function") return "absent";
  try {
    const result = submit.call(host, event as RunAuditEventInput);
    if (!result?.accepted) return "absent";
    // Backpressure is the only interesting hand-off: a queue at half its ceiling is a sink falling
    // behind, and that is the one moment the operator wants to have already seen.
    if ((result.queueDepth ?? 0) >= RUN_AUDIT_SINK_QUEUE_MAX / 2 && sinkNoticeDue(`queued:${event.mutationType}`)) {
      log.warn(`[run-audit] sink queued ${event.mutationType} behind ${result.queueDepth} row(s)`);
    }
    return "accepted";
  } catch {
    if (sinkNoticeDue(`submit-failed:${event.mutationType}`)) {
      log.warn(`[run-audit] sink refused ${event.mutationType} — wrote it directly instead`);
    }
    return "absent";
  }
}

/**
 * FNXC:RunAudit 2026-08-20-05:49:
 * FN-9177 keeps this bounded optional-audit seam in core deliberately: core cannot import engine
 * without creating its documented dependency cycle. Best-effort telemetry must not block, reject,
 * or otherwise alter the lifecycle operation which emitted it; no retry, queue, or backoff belongs here.
 *
 * FNXC:RunAuditSink 2026-09-30 (RUFU-453):
 * The deferral this seam always forbade to itself now lives BELOW the sink boundary, so handing the row
 * to that writer is what keeps the promise true under load instead of only under an idle pool. The
 * queue, the batching, and the spill are the writer's; this function still never blocks past its own
 * bound, still never throws, and still adds no retry of its own.
 */
export function emitBoundedRunAudit(
  host: RunAuditSinkHost,
  event: RunAuditEvent,
  options: { timeoutMs?: number; log?: RunAuditLogger } = {},
): Promise<void> {
  if (submitRunAuditToSinkWriter(host, event, options.log ?? defaultLog) === "accepted") {
    return Promise.resolve();
  }
  return emitBoundedRunAuditWithOutcome(host, event, options).then(() => undefined);
}

/**
 * FNXC:RunAudit 2026-08-20-07:14:
 * FN-9182 supplies an explicit result for callers whose forensic throw ordering or caller-visible
 * skipped payload derives from whether audit recording landed. This remains best-effort telemetry,
 * not a durability guarantee: it bounds hostile sinks while preserving their original failure value.
 */
export async function emitBoundedRunAuditWithOutcome(
  host: RunAuditSinkHost,
  event: RunAuditEvent,
  options: { timeoutMs?: number; log?: RunAuditLogger } = {},
): Promise<BoundedRunAuditResult> {
  const log = options.log ?? defaultLog;
  const sink = host?.recordRunAuditEvent;
  if (typeof sink !== "function") return { outcome: "absent" };

  let sinkPromise: Promise<unknown>;
  try {
    // Invoke before the first await: synchronous timeline consumers observe every audit attempt.
    sinkPromise = Promise.resolve(sink.call(host, event as RunAuditEventInput));
  } catch (error) {
    log.warn(`[run-audit] failed to record ${event.mutationType}`);
    return { outcome: "failed", error };
  }

  void sinkPromise.catch(() => undefined);
  return new Promise<BoundedRunAuditResult>((resolve) => {
    const timer = setTimeout(() => {
      /*
      FNXC:RunAuditSink 2026-09-30 (RUFU-453):
      This is now the AWAITED lane's own bound — `emitBoundedRunAudit` hands its row to the drain writer
      and never reaches here under load — so the line names the queue it stood beside instead of being
      the only trace of a whole class of loss. The row may still land; that is what `lateRecorded` counts,
      and saying so here is what stops the next reader from concluding the emitter never ran.
      */
      const depth = (() => {
        try {
          return host?.getRunAuditSinkStats?.()?.queueDepth;
        } catch {
          return undefined;
        }
      })();
      log.warn(
        `[run-audit] timed out recording ${event.mutationType}`
        + (typeof depth === "number" ? ` (sink queued=${depth}; the write itself may still land)` : ""),
      );
      resolve({ outcome: "timed-out" });
    }, options.timeoutMs ?? CORE_RUN_AUDIT_EMIT_TIMEOUT_MS);
    timer.unref?.();
    void sinkPromise.then(
      () => { clearTimeout(timer); resolve({ outcome: "recorded" }); },
      (error) => {
        clearTimeout(timer);
        log.warn(`[run-audit] failed to record ${event.mutationType}`);
        resolve({ outcome: "failed", error });
      },
    );
  });
}
