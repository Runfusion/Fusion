import type { RunAuditDomain, RunAuditEventInput } from "@fusion/core";
/*
FNXC:RunAuditSink 2026-09-30 (RUFU-453):
One hand-off implementation, not two. The engine and core seams stay mirrored where mirroring is the
point (logger resolution, mock shape), but the queue is a single writer under the store — so the engine
asks core's seam whether that writer took the row rather than re-deriving the same accept/throw rules.
*/
import { submitRunAuditToSinkWriter } from "@fusion/core";
import * as logger from "../logger.js";

export const RUN_AUDIT_EMIT_TIMEOUT_MS = 2_000;

export type RunAuditSinkHost = {
  recordRunAuditEvent?: (input: RunAuditEventInput) => unknown;
  /** Present on a store whose durable backend has a drain writer; absent on doubles and kill-switched hosts. */
  recordRunAuditEventBuffered?: (input: RunAuditEventInput) => { accepted: boolean; queued: boolean; spilled: boolean; queueDepth: number };
  getRunAuditSinkStats?: () => { queueDepth?: number; batches?: number } | null;
} | null | undefined;

export type RunAuditLogger = {
  warn: (message: string) => void;
};

export type BoundedRunAuditResult =
  | { outcome: "recorded" }
  | { outcome: "absent" }
  | { outcome: "failed"; error: unknown }
  | { outcome: "timed-out" };

/*
FNXC:RunAudit 2026-10-01-00:16, corrected 2026-10-01-00:26 (RUFU-430): the loose arm exists so test doubles
can hand the seam a partial event. It used to accept ANY key, including a `domain` outside `RunAuditDomain`.
Pinning it keeps the declared vocabulary honest — but it is HYGIENE, not the fix for RUFU-430's lost rows:
`run_audit_events.domain` has no CHECK constraint and 13,926 rows already carry the out-of-enum
`task-lifecycle`, while the demonstrated defect was the missing NOT NULL `target`. Do not read this pin as a
runtime guarantee; a required column is enforced by the store, and only an emit-shape test catches that.
*/
export type RunAuditEvent = RunAuditEventInput | {
  mutationType: string;
  domain?: RunAuditDomain;
  [key: string]: unknown;
};

/*
FNXC:RunAudit 2026-10-01-00:16 (RUFU-430): compile-time half of the guard, in a COMPILED file because
packages/engine/tsconfig.json excludes its test directory — an assertion placed in a test file would
never be type-checked. If the loose arm widens back to accepting any `domain`, the directive below stops erroring and
`pnpm typecheck` fails on the unused directive.
*/
// @ts-expect-error "merge" is not a RunAuditDomain; it is the value that made every RUFU-430 row vanish.
const _runAuditDomainIsClosedSet: RunAuditEvent = { mutationType: "guard", domain: "merge" };
void _runAuditDomainIsClosedSet;

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
  /*
  FNXC:RunAuditSink 2026-09-30 (RUFU-453):
  "No queue here" still means no queue HERE. 1332 timed-out writes in one 20 MB log came from this seam's
  2 s bound losing to a runtime pool of 3, so the fire-and-forget lane hands its row to the drain writer
  below the sink boundary and returns. Everything the seam promises is unchanged — never blocking, never
  throwing, no retry of its own — and `emitBoundedRunAuditWithOutcome` deliberately stays on the direct
  write because its callers branch on whether the row landed.
  */
  if (handOffToSinkWriter(host, event, options.log ?? resolveDefaultRunAuditLog())) {
    return Promise.resolve();
  }
  return emitBoundedRunAuditWithOutcome(host, event, options).then(() => undefined);
}

/*
FNXC:RunAuditSink 2026-11-03-05:55 (RUFU-453):
The seam promises it never throws, and a hand-off that is merely UNRESOLVABLE must not break that promise. The
`engine-core` merge-gate project resolves `@fusion/core` to the narrower gate barrel (`index.gate.ts`), where a symbol
can be absent even though it exists in the full barrel — the import then binds `undefined`, a synchronous call to it
throws, and every best-effort caller that swallows audit errors loses its row with no error naming the cause (measured:
55 silent audit failures in one gate file). So the hand-off is checked and contained here, and a missing helper means
exactly one thing: write the row directly, as the seam did before the drain existed.
*/
function handOffToSinkWriter(
  host: RunAuditSinkHost,
  event: RunAuditEvent,
  log: RunAuditLogger,
): boolean {
  try {
    return typeof submitRunAuditToSinkWriter === "function"
      && submitRunAuditToSinkWriter(host, event, log) === "accepted";
  } catch {
    return false;
  }
}

/*
FNXC:EngineDiagnostics 2026-08-23-18:45 (shape unchanged, now shared by both lanes):
Resolve the shipped run-audit logger lazily through the module namespace: focused subsystem tests
routinely `vi.mock("../logger.js")` with only their own exports, which leaves `runAuditLog` absent.
In production the export always exists, so the last-resort branch is unreachable there — it must
therefore be a silent no-op, NOT bare `console.warn`. Writing severity-marked output outside
`logger.ts` is exactly the reversion `log-severity-spam-contract` blocks, and adding a console
fallback to satisfy an incomplete test mock would put mock-shaped code in the ship path.
*/
function resolveDefaultRunAuditLog(): RunAuditLogger {
  try {
    return logger.runAuditLog ?? { warn: () => undefined };
  } catch {
    return { warn: () => undefined };
  }
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
  const log = options.log ?? resolveDefaultRunAuditLog();
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
      /*
      FNXC:RunAuditSink 2026-09-30 (RUFU-453):
      Only an AWAITED lane reports a timeout any more, and the line now names what the row was standing
      behind. It may still land — which is what the sink's `lateRecorded` counter counts — so the line
      says that too, instead of being misread as "this emitter never ran": the mistake that cost
      RUFU-451 its proof row.
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
