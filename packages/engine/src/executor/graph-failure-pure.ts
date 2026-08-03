/**
 * FNXC:CodeOrganization 2026-08-03-13:20:
 * Pure graph-failure classifiers peeled from TaskExecutor (U4).
 * No instance state — context/result string matching only.
 * Re-exported from executor.ts; call sites use free functions.
 */
import type { Task, TaskDetail, WorkflowIrNodeKind, WorkflowStepResult as CoreWorkflowStepResult } from "@fusion/core";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import {
  MERGE_REGION_KINDS,
  SESSION_CONTENTION_HOLD_VALUE,
} from "../workflows/workflow-graph-executor.js";
import { isMissingWorktreeSessionStartFailure } from "../healing/restart-recovery-coordinator.js";
import { isSessionContentionError } from "../errors/transient-error-detector.js";
import { PAUSE_ABORT_PARK_ERROR_MARKER } from "../self-healing.js";


/*
FNXC:SessionContention 2026-07-25-21:30:
Two ways in, because contention must never slip through to a park:
 - the typed failure value the graph now publishes (SESSION_CONTENTION_HOLD_VALUE), and
 - a message-shape fallback over the run's `:error` context patches, so contention arriving from a
   path that has not been taught the typed value is still recognized.
*/
export function graphFailureErrorTexts(result: WorkflowGraphTaskRunResult): string[] {
  if (!result.context) return [];
  const texts: string[] = [];
  for (const [key, value] of Object.entries(result.context)) {
    if (key.endsWith(":error") && typeof value === "string" && value.trim()) texts.push(value);
  }
  return texts;
}


/*
FNXC:WorkflowExecutionOwnership 2026-07-30-10:10 (U8, PR #2599 review — coderabbit, major):
A visited node id does NOT always name the context key its value is stored under, and the two
shapes that differ are the ones this unit cares about most. A foreach instance
(`steps#0:step-execute`) records under the CONTAINER key `node:steps:value`; an optional-group
template (`group::template`) records under the group key, then the template key. Reading
`node:<visitedId>:value` directly therefore misses a foreach ending and walks on to some
earlier node's value — and the default coding workflow IS a foreach, so the backward walk
would have misread precisely the shape it was written for.

Extracted from `graphFailureValue`, which already knew this, so the two cannot drift apart.
*/
export function recordedNodeValue(context: Record<string, unknown>, nodeId: string): string | undefined {
  const direct = context[`node:${nodeId}:value`];
  if (typeof direct === "string") return direct;
  const groupDelimiter = nodeId.indexOf("::");
  if (groupDelimiter !== -1) {
    const groupValue = context[`node:${nodeId.slice(0, groupDelimiter)}:value`];
    if (typeof groupValue === "string") return groupValue;
    const templateValue = context[`node:${nodeId.slice(groupDelimiter + 2)}:value`];
    return typeof templateValue === "string" ? templateValue : undefined;
  }
  const foreachDelimiter = nodeId.indexOf("#");
  if (foreachDelimiter === -1) return undefined;
  const containerValue = context[`node:${nodeId.slice(0, foreachDelimiter)}:value`];
  return typeof containerValue === "string" ? containerValue : undefined;
}

export function graphFailureValue(result: WorkflowGraphTaskRunResult): string | undefined {
  const failedNode = result.visitedNodeIds[result.visitedNodeIds.length - 1];
  if (!failedNode || !result.context) return undefined;
  const value = result.context[`node:${failedNode}:value`];
  if (typeof value === "string") return value;
  /*
  FNXC:WorkflowLifecycle 2026-07-16-18:20:
  Optional-group template failures record materialized `<groupId>::<templateId>` ids in
  visitedNodeIds, but runOptionalGroup publishes context values under the UNQUALIFIED
  template id, and the group wrapper publishes the group's FINAL routing value (e.g.
  FN-7977's plan-review provider-failure hold) under the group id. FN-7996 parked
  terminally because this lookup only understood `#` foreach ids, so every graph-failure
  router (provider hold, awaiting states) missed group-template failures. Prefer the
  group's own value (it carries post-classification routing intent), then the template's.
  */
  const groupInstanceDelimiter = failedNode.indexOf("::");
  if (groupInstanceDelimiter !== -1) {
    const groupNode = failedNode.slice(0, groupInstanceDelimiter);
    const groupValue = result.context[`node:${groupNode}:value`];
    if (typeof groupValue === "string") return groupValue;
    const templateNode = failedNode.slice(groupInstanceDelimiter + 2);
    const templateValue = result.context[`node:${templateNode}:value`];
    return typeof templateValue === "string" ? templateValue : undefined;
  }
  const foreachInstanceDelimiter = failedNode.indexOf("#");
  if (foreachInstanceDelimiter === -1) return undefined;
  /*
  FNXC:WorkflowLifecycle 2026-06-15-03:23:
  Foreach step-execute failures record instance ids in visitedNodeIds, but the graph walk stores the failed value on the foreach container context key. Check that container key before classifying execute-node failures so awaiting operator states from step-execute are preserved instead of parked as terminal graph failures.
  */
  const foreachContainerNode = failedNode.slice(0, foreachInstanceDelimiter);
  const containerValue = result.context[`node:${foreachContainerNode}:value`];
  return typeof containerValue === "string" ? containerValue : undefined;
}


/*
FNXC:MissingWorktreeRecovery 2026-07-16-18:25:
FN-7996: a session-start unusable-worktree refusal (assertValidWorktreeSession in pi.ts)
thrown inside ANY workflow graph node (Plan Review, code review, custom gates) surfaced as a
generic node "exception" and fell through every graph-failure router into the terminal park,
which also OVERWROTE task.error with a generic message — erasing the signature the in-review
missing-worktree self-healing sweep classifies on. The overseer then blindly re-dispatched the
same stale task.worktree all day. Extract the underlying node error from the graph context so
handleGraphFailure can route these into the same bounded recovery the execute session-start
path already uses (clear stale worktree/branch/session metadata, requeue to todo, budgeted by
worktreeSessionRetryCount).
*/
export function extractUnusableWorktreeGraphFailure(result: WorkflowGraphTaskRunResult): string | null {
  if (!result.context) return null;
  const failedNode = result.visitedNodeIds[result.visitedNodeIds.length - 1];
  if (!failedNode) return null;
  /*
  FNXC:MissingWorktreeRecovery 2026-07-16-19:40:
  Detection is scoped to the FAILED node's error keys only (exact id, plus the
  `group::template` / `container#N:template` materialized-id derivations under which
  runOptionalGroup/foreach publish template context). A catch-all scan over every
  `node:*:error` entry would match a STALE error left by an earlier, already-handled node
  and misroute an unrelated later failure into worktree recovery (greptile PR#2231 P1).
  */
  const candidateKeys: string[] = [`node:${failedNode}:error`];
  const groupInstanceDelimiter = failedNode.indexOf("::");
  if (groupInstanceDelimiter !== -1) {
    candidateKeys.push(`node:${failedNode.slice(groupInstanceDelimiter + 2)}:error`);
    candidateKeys.push(`node:${failedNode.slice(0, groupInstanceDelimiter)}:error`);
  }
  const foreachInstanceDelimiter = failedNode.indexOf("#");
  if (foreachInstanceDelimiter !== -1) {
    candidateKeys.push(`node:${failedNode.slice(0, foreachInstanceDelimiter)}:error`);
    const instanceRest = failedNode.slice(foreachInstanceDelimiter + 1);
    const templateDelimiter = instanceRest.indexOf(":");
    if (templateDelimiter !== -1) {
      candidateKeys.push(`node:${instanceRest.slice(templateDelimiter + 1)}:error`);
    }
  }
  for (const key of candidateKeys) {
    const value = result.context[key];
    if (typeof value === "string" && isMissingWorktreeSessionStartFailure(value)) return value;
  }
  return null;
}

export function isMergeGraphFailure(failedNode: string | undefined): boolean {
  /*
  FNXC:WorkflowLifecycle 2026-06-19-00:00:
  FN-6735 requires every workflow merge-region node id to classify as a merge-seam graph failure. A benign pause/resume abort can surface as the synthetic legacy `merge`, `requestMerge`, or a primitive merge-region id, and all must route through bounded merge retry rather than terminal operator-action parking.
  */
  if (!failedNode) return false;
  if (failedNode === "merge" || failedNode === "requestMerge") return true;
  if (MERGE_REGION_KINDS.has(failedNode as WorkflowIrNodeKind)) return true;
  return failedNode === "merge-manual-hold" || failedNode === "merge-retry";
}

export function latestFailedPreMergeWorkflowStep(
  task: Pick<Task, "workflowStepResults"> | Pick<TaskDetail, "workflowStepResults">,
): CoreWorkflowStepResult | undefined {
  return (task.workflowStepResults ?? [])
    .filter((r) => (r.phase || "pre-merge") === "pre-merge" && r.status === "failed")
    .sort((a, b) => {
      const aTs = Date.parse(a.completedAt || a.startedAt || "");
      const bTs = Date.parse(b.completedAt || b.startedAt || "");
      return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
    })[0];
}

export function isStalePauseAbortParkFailure(live: TaskDetail, nodeId = "plan"): boolean {
  return live.status === "failed"
    && typeof live.error === "string"
    && live.error.includes(PAUSE_ABORT_PARK_ERROR_MARKER)
    && live.error.includes("engine abort during pause/resume")
    && live.error.includes(`at node '${nodeId}'`);
}

export function isSessionContentionGraphFailure(result: WorkflowGraphTaskRunResult): boolean {
  if (graphFailureValue(result) === SESSION_CONTENTION_HOLD_VALUE) return true;
  return graphFailureErrorTexts(result).some((text) => isSessionContentionError(text));
}

/** True only for the pre-session refresh refusal values emitted by graph preparation. */
export function isWorktreeBaseRefreshGraphFailure(result: WorkflowGraphTaskRunResult): boolean {
  return new Set([
    "stale-base-conflict",
    "dirty-worktree",
    "base-unresolvable",
    "worktrunk-refresh-unsupported",
    "git-refresh-failed",
    "base-persistence-failed-compensated",
    "base-reconciliation-required",
  ]).has(graphFailureValue(result) ?? "");
}

/*
FNXC:WorkflowExecutionOwnership 2026-07-29-20:10 (U8 / R4, PR #2590 review — greptile):
The compat classifier keyed on `graphFailureValue`, which reads only the LAST visited node's
value. That is correct when the generic `failure` edge goes straight to `end` — the built-in
shape — but a user-authored graph may route its generic failure THROUGH another node, and that
node's value then becomes the terminal one. The classifier would miss the pending-review ending
entirely and the card would fall to the terminal park: `status: failed` on work that was only
WAITING for a reviewer, which is the deadlock the inline handoff existed to avoid. A guard that
cannot fire for the exact shape it was written for.

The ending is durable in the run context — the graph publishes `node:<id>:value` for every node
it runs — so detect it there rather than trusting whichever node happened to end the walk.
*/
export function graphRunReportedPendingReview(
  result: WorkflowGraphTaskRunResult,
  failureValue: string | undefined,
): boolean {
  if (failureValue === "review-pending") return true;
  const context = result.context;
  if (!context) return false;
  /*
  FNXC:WorkflowExecutionOwnership 2026-07-29-21:40 (U8 / R4, PR #2590 review — greptile, 2nd):
  Scanning EVERY `node:*:value` was too broad in the opposite direction. The run context is
  shared for the whole walk, so a graph that continues past a pending-review node and then dies
  on a genuine downstream failure still carries the earlier value — and a blanket scan would
  park that card in review, hiding a real failure behind a wait. Trading a guard that misses for
  one that over-claims is not a fix.

  The narrow rule: the pending-review ending counts only when nothing AFTER it produced its own
  verdict. Walk the visited nodes backwards and take the first recorded value — that is the
  run's actual last word. If it is `review-pending`, the ending stands; if a later node spoke,
  that node's outcome is the run's, and this classifier stays out of the way.
  */
  for (let i = result.visitedNodeIds.length - 1; i >= 0; i--) {
    const value = recordedNodeValue(context, result.visitedNodeIds[i]);
    if (typeof value === "string") return value === "review-pending";
  }
  return false;
}
