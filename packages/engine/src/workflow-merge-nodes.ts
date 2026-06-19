import type { TaskDetail } from "@fusion/core";
import type { MergePrimitiveResult, WorkflowPrimitiveContext, WorkflowRuntimePrimitives } from "./runtime-primitives.js";
import type { WorkflowNodeResult } from "./workflow-graph-executor.js";

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
  const normalized = reason.toLowerCase();
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
