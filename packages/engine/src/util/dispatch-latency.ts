/*
FNXC:EventDrivenDispatch 2026-09-18-00:40:
FN-519 — bounded diagnostic for "why did this card wait?".

The operator's question is not answerable by a green test suite: after the fact, a card that sat
queued leaves no trace of WHICH of the five possible causes applied — a deliberate added wait,
necessary I/O, real contention, a missing signal, or provider latency. Before this, the binding gate
existed only in a log line persisted nowhere, so a stall could not be attributed at all (the same
defect FN-8600 named for planning admission).

Design constraints, each answering a specific failure:

  * IDS, BOUNDED ENUMS, AND ONE DURATION ONLY. The row must never carry prompts, titles, task
    content, reviewer prose, error text, blocker prose, connection URLs, or secrets.
  * DEDUPLICATED ON A STABLE SIGNATURE. A refusal that persists (capacity full, awaiting approval)
    must collapse to one row rather than one per pass, or the diagnostic becomes the load it was
    meant to explain. A NEW signature is never swallowed.
  * NEVER AWAITED BEFORE A CLAIM OR HANDOFF. Emission goes through `emitBoundedRunAudit`, which
    absorbs absent, throwing, rejecting, hung, and late-settling sinks. A stalled telemetry sink
    must not be able to delay the dispatch it describes — that would make this diagnostic a new
    source of the latency it exists to measure.
  * SINGLE-PROCESS OBSERVATIONS. `observedMs` is measured within one process. A cross-process wake
    is reported as an OBSERVATION with its origin, never as a monotonic duration computed between
    two unsynchronized clocks.
*/

import type { RunAuditSinkHost } from "./emit-bounded-run-audit.js";
import { emitBoundedRunAudit } from "./emit-bounded-run-audit.js";

/** What woke the lane. Fixed set: a new origin is an explicit code change, not free text. */
export type DispatchWakeOrigin =
  /** A publication from this process (a task move, a settings change, a continuation write). */
  | "local-publication"
  /** A notification delivered from another process. */
  | "remote-notification"
  /** Shared capacity was returned. */
  | "capacity-release"
  /** An owning session finished and released the card. */
  | "owner-cleanup"
  /** The catch-up read after LISTEN or a reconnect. */
  | "catch-up"
  /** The periodic sweep — present in a row means the event path did NOT deliver. */
  | "periodic-backstop";

/** Which boundary the observation describes. */
export type DispatchPhase =
  | "admission"
  | "claim"
  | "session-preparation"
  | "node-entry";

/** Whether the pass acted, and if not, why — from a fixed set, never prose. */
export type DispatchOutcome = "claimed" | "refused" | "no-candidate";

export type DispatchRefusalReason =
  | "capacity"
  | "worktree-capacity"
  | "paused"
  | "awaiting-approval"
  | "dependency"
  | "external-block"
  | "planner-live"
  | "deferred-deadline"
  | "lost-claim"
  | "transport-degraded";

export interface DispatchLatencyObservation {
  readonly taskId?: string;
  readonly nodeId?: string;
  readonly wakeOrigin: DispatchWakeOrigin;
  readonly phase: DispatchPhase;
  readonly outcome: DispatchOutcome;
  /** Wall-clock observation within THIS process. Omitted when no boundary was measured. */
  readonly observedMs?: number;
  readonly reasonCode?: DispatchRefusalReason;
}

/**
 * The dedupe signature. Includes the task, phase, outcome, and refusal reason but NOT the duration:
 * a stable refusal must collapse even though its measured wait keeps growing, while a card whose
 * refusal reason CHANGES (capacity → dependency) is a new fact and is always reported.
 */
export function dispatchLatencySignature(observation: DispatchLatencyObservation): string {
  return [
    observation.taskId ?? "",
    observation.nodeId ?? "",
    observation.phase,
    observation.outcome,
    observation.reasonCode ?? "",
  ].join("\u0000");
}

export interface DispatchLatencyRecorderOptions {
  readonly host: RunAuditSinkHost;
  /** Bound on retained signatures, so a long-lived runtime cannot grow this map without limit. */
  readonly maxSignatures?: number;
}

export interface DispatchLatencyRecorder {
  /**
   * Record one observation. Returns whether a row was ENQUEUED (not whether it landed — the sink's
   * success is deliberately not a caller concern). Never throws, never awaits the sink.
   */
  record(observation: DispatchLatencyObservation): boolean;
  /** Forget a card's retained signatures, e.g. once it finally claims. */
  forget(taskId: string): void;
  /** Diagnostics/tests: how many signatures are currently suppressed. */
  readonly retainedCount: number;
}

const DEFAULT_MAX_SIGNATURES = 512;

export function createDispatchLatencyRecorder(
  options: DispatchLatencyRecorderOptions,
): DispatchLatencyRecorder {
  const seen = new Set<string>();
  const max = Math.max(1, options.maxSignatures ?? DEFAULT_MAX_SIGNATURES);

  return {
    get retainedCount() {
      return seen.size;
    },
    forget(taskId: string) {
      if (!taskId) return;
      for (const signature of [...seen]) {
        if (signature.startsWith(`${taskId}\u0000`)) seen.delete(signature);
      }
    },
    record(observation) {
      try {
        /*
        A CLAIM is always reported: it is the answer to "when did it actually start?", it happens
        once per card per phase, and suppressing it would leave the interesting case invisible while
        reporting only the boring refusals.
        */
        const signature = dispatchLatencySignature(observation);
        if (observation.outcome !== "claimed") {
          if (seen.has(signature)) return false;
          // Bounded retention: drop the oldest insertion rather than grow without limit. Losing a
          // suppression only costs one extra row, never a missing fact.
          if (seen.size >= max) {
            const oldest = seen.values().next().value;
            if (oldest !== undefined) seen.delete(oldest);
          }
          seen.add(signature);
        } else {
          seen.delete(signature);
        }

        void emitBoundedRunAudit(options.host, {
          taskId: observation.taskId,
          agentId: "system",
          domain: "database",
          mutationType: "task:dispatch-latency-observed",
          target: observation.taskId ?? observation.nodeId ?? "dispatch",
          metadata: {
            ...(observation.taskId ? { taskId: observation.taskId } : {}),
            ...(observation.nodeId ? { nodeId: observation.nodeId } : {}),
            wakeOrigin: observation.wakeOrigin,
            phase: observation.phase,
            outcome: observation.outcome,
            ...(observation.observedMs !== undefined
              ? { observedMs: Math.max(0, Math.round(observation.observedMs)) }
              : {}),
            ...(observation.reasonCode ? { reasonCode: observation.reasonCode } : {}),
          },
        } as never);
        return true;
      } catch {
        // A diagnostic must never be able to break the lane it observes.
        return false;
      }
    },
  };
}
