import type { TaskDetail } from "@fusion/core";
import type { MergePrimitiveResult, WorkflowPrimitiveContext, WorkflowRuntimePrimitives } from "../execution/runtime-primitives.js";
import type { WorkflowNodeResult } from "./workflow-graph-executor.js";

/** A terminal graph value: retrying cannot create missing merge-boundary proof. */
export const MERGE_BOUNDARY_UNPROVEN_VALUE = "merge-boundary-unproven";

export const PRESERVED_MERGE_FAILURE_REASONS = new Set(["implementation-incomplete", "merge-unavailable", "workspace-review-required"]);

export interface WorkflowMergeNodeDeps {
  primitives: Pick<WorkflowRuntimePrimitives, "requestMerge" | "audit">;
}

export async function runWorkflowMergeAttemptNode(
  deps: WorkflowMergeNodeDeps,
  ctx: WorkflowPrimitiveContext,
  task: TaskDetail,
): Promise<WorkflowNodeResult> {
  const result = await deps.primitives.requestMerge(ctx, task);
  const classified = classifyMergePrimitiveResult(result.data, result.value, result.outcome);
  try {
    await deps.primitives.audit(ctx, {
      type: "workflow-merge-node",
      message: `workflow merge node classified ${classified.value ?? classified.outcome}`,
      metadata: { taskId: task.id, primitiveOutcome: result.outcome, primitiveValue: result.value, primitiveData: result.data },
    });
  } catch {
    // Audit is diagnostic; a transient audit failure must not re-run the merge primitive.
  }
  return {
    outcome: classified.outcome,
    value: classified.value,
    contextPatch: { ...(result.contextPatch ?? {}), "workflow:merge-status": classified.value ?? classified.outcome },
  };
}

export function classifyMergePrimitiveResult(
  data: MergePrimitiveResult | undefined,
  value: string | undefined,
  primitiveOutcome: WorkflowNodeResult["outcome"],
): WorkflowNodeResult {
  /*
  FNXC:WorkflowMerge 2026-08-20-00:50:
  FN-9157 requires an unprovable merge boundary to remain terminal on direct
  merge-attempt dispatch. Preserve this explicit value before failed-data
  classification, whose unknown-reason fallback is merge-failed and would repeat
  the boundary retry.
  */
  if (value === MERGE_BOUNDARY_UNPROVEN_VALUE) {
    return { outcome: "failure", value: MERGE_BOUNDARY_UNPROVEN_VALUE };
  }
  if (data?.status === "merged") {
    return { outcome: "success", value: data.noOp ? "already-landed" : "merged" };
  }
  if (data?.status === "manual-required") {
    return { outcome: "success", value: "manual-required" };
  }
  if (data?.status === "timeout") {
    return { outcome: "success", value: "transient-failure" };
  }
  if (data?.status === "failed") {
    return classifyMergeFailure(data.reason);
  }
  if (data?.status === "merged-requested") {
    return { outcome: "success", value: "merged-requested" };
  }
  if (data?.status === "stale-head") {
    return { outcome: primitiveOutcome, value: "stale-head" };
  }
  if (value === "transient-failure" || value === "manual-required" || value === "stale-head" || value === "not-actionable" || value === "merged-requested") {
    return { outcome: "success", value };
  }
  return { outcome: primitiveOutcome, value };
}

function classifyMergeFailure(reason: string): WorkflowNodeResult {
  const normalized = reason.trim().toLowerCase();
  /*
  FNXC:WorkflowMerge 2026-08-20-02:36:
  Structured engine sentinels must survive classification: these heuristics are only for free-text
  merge-requester reasons, and renaming exact literals made primitive merge-attempt dispatch disagree
  with the legacy merge seam for the same engine state. implementation-incomplete protects its no-op
  merge-proof route; merge-unavailable deliberately remains non-terminal because it is emitted only
  when mergeRequester is absent and routeGraphMergeFailureToRetry returns false on that same absence.
  Marking it terminal would instead park both paths as operator-action-required failures.

  FNXC:WorkspaceReviewReroute 2026-08-21-20:11:
  A live workspace merge rejection returns this exact typed value so the graph follows its
  explicit merge-attempt → Code Review rework edge instead of terminalizing as merge-failed.
  */
  if (PRESERVED_MERGE_FAILURE_REASONS.has(normalized)) {
    return { outcome: "failure", value: normalized };
  }
  if (normalized.includes("file scope") || normalized.includes("filescope")) {
    return { outcome: "failure", value: "file-scope-violation" };
  }
  if (normalized.includes("already") && (normalized.includes("main") || normalized.includes("merged") || normalized.includes("landed"))) {
    return { outcome: "success", value: "already-landed" };
  }
  if (normalized.includes("timeout") || normalized.includes("econnreset") || normalized.includes("socket") || normalized.includes("transient")) {
    return { outcome: "success", value: "transient-failure" };
  }
  if (normalized.includes("manual") || normalized.includes("conflict")) {
    return { outcome: "success", value: "manual-required" };
  }
  return { outcome: "failure", value: "merge-failed" };
}
