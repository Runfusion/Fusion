import type { TaskStore } from "@fusion/core";
import { generateSyntheticRunId } from "../util/run-audit.js";
import { emitBoundedRunAudit } from "./emit-bounded-run-audit.js";
import type { MergeBoundaryUnprovenReasonCode } from "./workflow-merge-boundary.js";

export const MERGE_BOUNDARY_UNPROVEN_AUDIT_EMIT_TIMEOUT_MS = 2_000;

type MergeBoundaryUnprovenParkedAuditPayload = {
  taskId: string;
  nodeId: string;
  failureValue: string;
  source: "retry-boundary" | "graph-terminal-park";
  reasonCode?: MergeBoundaryUnprovenReasonCode;
  missingInstanceCount?: number;
  priorColumn: string;
  priorStatus: string | null | undefined;
  outcome: "parked" | "already-terminal";
  runId?: string;
};

/**
 * FNXC:RunAudit 2026-08-20-02:00:
 * FN-9168 requires observability never to regress or stall delivery. The merge-boundary park is
 * terminal and correct on its own, so absent, throwing, rejecting, or never-settling audit sinks
 * are swallowed and time-bounded here. Callers await only ordering, never success: an unbounded
 * await after the terminal write would wedge the executor branch, skipping token persistence and
 * its return. Failure isolation is swallow-log-and-bound, with no retry, backoff, or queueing.
 */
export async function emitMergeBoundaryUnprovenParked(
  store: TaskStore | null | undefined,
  payload: MergeBoundaryUnprovenParkedAuditPayload,
): Promise<void> {
  await emitBoundedRunAudit(store, {
    taskId: payload.taskId,
    agentId: "executor",
    runId: payload.runId ?? generateSyntheticRunId("merge-boundary-unproven-park", payload.taskId),
    domain: "database",
    mutationType: "task:merge-boundary-unproven-parked",
    target: payload.taskId,
    metadata: {
      taskId: payload.taskId,
      nodeId: payload.nodeId,
      failureValue: payload.failureValue,
      source: payload.source,
      ...(payload.reasonCode === undefined ? {} : { reasonCode: payload.reasonCode }),
      ...(payload.missingInstanceCount === undefined ? {} : { missingInstanceCount: payload.missingInstanceCount }),
      priorColumn: payload.priorColumn,
      priorStatus: payload.priorStatus ?? null,
      outcome: payload.outcome,
    },
  }, { timeoutMs: MERGE_BOUNDARY_UNPROVEN_AUDIT_EMIT_TIMEOUT_MS });
}
