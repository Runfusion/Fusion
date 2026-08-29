import type { RunAuditEventInput } from "@fusion/core";
import * as logger from "../logger.js";

export const RUN_AUDIT_EMIT_TIMEOUT_MS = 2_000;

export type RunAuditSinkHost = {
  recordRunAuditEvent?: (input: RunAuditEventInput) => unknown;
} | null | undefined;

export type RunAuditLogger = {
  warn: (message: string) => void;
};

export type BoundedRunAuditResult =
  | { outcome: "recorded" }
  | { outcome: "absent" }
  | { outcome: "failed"; error: unknown }
  | { outcome: "timed-out" };

type RunAuditEvent = RunAuditEventInput | {
  mutationType: string;
  [key: string]: unknown;
};

/**
 * FNXC:RunAudit 2026-08-20-04:15:
 * FN-9175 makes run-audit writes best-effort telemetry for every engine subsystem. A sink may be
 * absent, throw, reject, or never settle; swallowing, logging, and bounding it prevents telemetry
 * from becoming a lifecycle dependency. This seam intentionally adds no retry, queue, or backoff.
 */
export function emitBoundedRunAudit(
  host: RunAuditSinkHost,
  event: RunAuditEvent,
  options: { timeoutMs?: number; log?: RunAuditLogger } = {},
): Promise<void> {
  return emitBoundedRunAuditWithOutcome(host, event, options).then(() => undefined);
}

/**
 * FNXC:RunAudit 2026-08-23-18:30:
 * Engine mirror of core's `emitBoundedRunAuditWithOutcome` (FN-9182), for the few emitters whose
 * OWN behavior branches on whether the audit row actually landed. FN-9175 made every engine audit
 * write swallow its sink failure; triage's plan-admission throttle relied on the opposite — it sets
 * its dedupe marker only once the write lands, so a failed write retries on the next poll instead
 * of being suppressed for the whole stall. With the outcome erased, a single contended write
 * silenced the stall permanently, which is exactly the unanswerable-stall defect FN-8600 fixed.
 * This is still best-effort telemetry: bounded, never rethrowing, no retry/queue/backoff here.
 */
export async function emitBoundedRunAuditWithOutcome(
  host: RunAuditSinkHost,
  event: RunAuditEvent,
  options: { timeoutMs?: number; log?: RunAuditLogger } = {},
): Promise<BoundedRunAuditResult> {
  /*
  FNXC:EngineDiagnostics 2026-08-23-18:45:
  Resolve the shipped run-audit logger lazily through the module namespace: focused subsystem tests
  routinely `vi.mock("../logger.js")` with only their own exports, which leaves `runAuditLog`
  absent. In production the export always exists, so the last-resort branch is unreachable there —
  it must therefore be a silent no-op, NOT bare `console.warn`. Writing severity-marked output
  outside `logger.ts` is exactly the reversion `log-severity-spam-contract` blocks, and adding a
  console fallback to satisfy an incomplete test mock would put mock-shaped code in the ship path.
  */
  let defaultLog: RunAuditLogger | undefined;
  try {
    defaultLog = logger.runAuditLog;
  } catch {
    defaultLog = undefined;
  }
  const log = options.log ?? defaultLog ?? { warn: () => undefined };
  const sink = host?.recordRunAuditEvent;
  if (typeof sink !== "function") return { outcome: "absent" };

  let sinkPromise: Promise<unknown>;
  try {
    sinkPromise = Promise.resolve(sink.call(host, event as RunAuditEventInput));
  } catch (error) {
    log.warn(`[run-audit] failed to record ${event.mutationType}`);
    return { outcome: "failed", error };
  }

  // Observe late rejection before the bounded wait returns so it cannot become unhandled.
  void sinkPromise.catch(() => undefined);
  return await new Promise<BoundedRunAuditResult>((resolve) => {
    const timer = setTimeout(() => {
      log.warn(`[run-audit] timed out recording ${event.mutationType}`);
      resolve({ outcome: "timed-out" });
    }, options.timeoutMs ?? RUN_AUDIT_EMIT_TIMEOUT_MS);
    timer.unref?.();
    void sinkPromise.then(
      () => {
        clearTimeout(timer);
        resolve({ outcome: "recorded" });
      },
      (error) => {
        clearTimeout(timer);
        log.warn(`[run-audit] failed to record ${event.mutationType}`);
        resolve({ outcome: "failed", error });
      },
    );
  });
}
