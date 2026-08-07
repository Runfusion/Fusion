/**
 * FNXC:CodeOrganization 2026-08-03-13:55:
 * isRemediationGraphNode / isPreMergeRemediationGraphNode peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowRemediation 2026-07-01-23:40:
 * Remediation nodes are fire-and-forget schedulers; terminal failure must not stamp failed while a fix session lives.
 *
 * FNXC:WorkflowRemediation 2026-07-03-23:10:
 * Pre-merge remediation only for optional-step recovery; plan-replan stays on replan/triage.
 */
import type { TaskStore } from "@fusion/core";
import { resolveWorkflowIrForTask } from "@fusion/core";

export type RemediationGraphNodeDeps = {
  store: TaskStore;
};

export async function isRemediationGraphNode(
  deps: RemediationGraphNodeDeps,
  taskId: string,
  failedNode: string | undefined,
): Promise<boolean> {
  if (!failedNode) return false;
  try {
    const ir = await resolveWorkflowIrForTask(deps.store, taskId);
    const node = ir?.nodes?.find((n) => n.id === failedNode);
    const action = node?.config?.workflowAction;
    if (action === "pre-merge-remediation" || action === "plan-replan") return true;
    if (node) return false;
  } catch {
    // Best-effort IR resolution; fall through to the built-in id fallback.
  }
  return (
    failedNode === "code-review-remediation"
    || failedNode === "browser-verification-remediation"
    || failedNode === "plan-replan"
  );
}

export async function isPreMergeRemediationGraphNode(
  deps: RemediationGraphNodeDeps,
  taskId: string,
  failedNode: string | undefined,
): Promise<boolean> {
  if (!failedNode) return false;
  try {
    const ir = await resolveWorkflowIrForTask(deps.store, taskId);
    const node = ir?.nodes?.find((n) => n.id === failedNode);
    const action = node?.config?.workflowAction;
    if (action === "pre-merge-remediation") return true;
    if (node) return false;
  } catch {
    // Best-effort IR resolution; fall through to the built-in id fallback.
  }
  return failedNode === "code-review-remediation" || failedNode === "browser-verification-remediation";
}
