import type { RunAuditEventInput } from "@fusion/core";
import * as logger from "../logger.js";

export const RUN_AUDIT_EMIT_TIMEOUT_MS = 2_000;

export type RunAuditSinkHost = {
  recordRunAuditEvent?: (input: RunAuditEventInput) => unknown;
} | null | undefined;

export type RunAuditLogger = {
  warn: (message: string) => void;
};

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
export async function emitBoundedRunAudit(
  host: RunAuditSinkHost,
  event: RunAuditEvent,
  options: { timeoutMs?: number; log?: RunAuditLogger } = {},
): Promise<void> {
  // Focused subsystem tests can mock only their own logger exports.
  let defaultLog: RunAuditLogger | undefined;
  try {
    defaultLog = logger.runAuditLog;
  } catch {
    defaultLog = undefined;
  }
  const log = options.log ?? defaultLog ?? { warn: (message: string) => console.warn(message) };
  const sink = host?.recordRunAuditEvent;
  if (typeof sink !== "function") return;

  let sinkPromise: Promise<unknown>;
  try {
    sinkPromise = Promise.resolve(sink.call(host, event as RunAuditEventInput));
  } catch {
    log.warn(`[run-audit] failed to record ${event.mutationType}`);
    return;
  }

  // Observe late rejection before the bounded wait returns so it cannot become unhandled.
  void sinkPromise.catch(() => undefined);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log.warn(`[run-audit] timed out recording ${event.mutationType}`);
      resolve();
    }, options.timeoutMs ?? RUN_AUDIT_EMIT_TIMEOUT_MS);
    timer.unref?.();
    void sinkPromise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        log.warn(`[run-audit] failed to record ${event.mutationType}`);
        resolve();
      },
    );
  });
}
