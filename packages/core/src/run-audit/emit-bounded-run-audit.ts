import type { RunAuditEventInput } from "../types.js";
import { createLogger } from "../process/logger.js";

export const CORE_RUN_AUDIT_EMIT_TIMEOUT_MS = 2_000;

export type RunAuditSinkHost = {
  recordRunAuditEvent?: (input: RunAuditEventInput) => unknown;
} | null | undefined;

export type RunAuditLogger = { warn: (message: string) => void };

export type BoundedRunAuditResult =
  | { outcome: "recorded" }
  | { outcome: "absent" }
  | { outcome: "failed"; error: unknown }
  | { outcome: "timed-out" };

type RunAuditEvent = RunAuditEventInput | { mutationType: string; [key: string]: unknown };

const defaultLog = createLogger("run-audit");

/**
 * FNXC:RunAudit 2026-08-20-05:49:
 * FN-9177 keeps this bounded optional-audit seam in core deliberately: core cannot import engine
 * without creating its documented dependency cycle. Best-effort telemetry must not block, reject,
 * or otherwise alter the lifecycle operation which emitted it; no retry, queue, or backoff belongs here.
 */
export function emitBoundedRunAudit(
  host: RunAuditSinkHost,
  event: RunAuditEvent,
  options: { timeoutMs?: number; log?: RunAuditLogger } = {},
): Promise<void> {
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
      log.warn(`[run-audit] timed out recording ${event.mutationType}`);
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
