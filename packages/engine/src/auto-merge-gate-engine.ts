/**
 * Engine-side binding for the core `shouldAutoMergeTask` chokepoint (U7).
 *
 * `@fusion/core`'s {@link shouldAutoMergeTask} is pure: it takes the resolved
 * facts (per-task override, global setting, merge mode, company-board flag,
 * verdict status, manual-approval marker) and returns a routing decision. This
 * module resolves those facts from the engine's stores/resolver and calls the
 * predicate, so engine trigger gates (merger enqueue, self-healing sweeps, the
 * verdict-pass enqueue seam) consult the one chokepoint without re-deriving the
 * facts each.
 *
 * `prMode` is derived from the task's resolved workflow IR: a board whose IR
 * carries any `pr-*` node kind is PR-mode (the unified PR entity drives merge;
 * the legacy queue is never used). `isCompanyBoard` is the company-model flag AND
 * `isCompanyBoardIr`. The verdict status is read from the {@link TaskReviewerStore}
 * (`pass` / `fail` / pending). The manual-approval marker is read from the task
 * log via {@link hasManualApprovalMarker}.
 */

import {
  hasManualApprovalMarker,
  isCompanyBoardIr,
  isCompanyModelEnabled,
  resolveWorkflowIrForTask,
  shouldAutoMergeTask,
  type ReviewerVerdictStatus,
  type Settings,
  type ShouldAutoMergeResult,
  type Task,
  type TaskStore,
  type WorkflowIr,
} from "@fusion/core";

/** PR-mode = the IR contains any unified-PR-entity node kind. */
const PR_NODE_KINDS = new Set(["pr-create", "pr-respond", "pr-merge"]);

export function irIsPrMode(ir: WorkflowIr): boolean {
  return ir.nodes.some((n) => PR_NODE_KINDS.has(n.kind));
}

/** Map the persisted Reviewer verdict status onto the gate's tri-state. A
 *  `blocked`/`error`/missing terminal verdict reads as `pending` (not pass, not
 *  a definitive fail) so the gate blocks rather than auto-enqueues. */
function toVerdictStatus(status: string | undefined): ReviewerVerdictStatus {
  if (status === "pass") return "pass";
  if (status === "fail") return "fail";
  return "pending";
}

export interface AutoMergeGateEngineDeps {
  store: TaskStore;
  /** Settings provider override (tests). Defaults to `store.getSettings()`. */
  getSettings?: () => Promise<Pick<Settings, "autoMerge" | "experimentalFeatures"> | undefined>;
}

/**
 * Resolve the auto-merge routing for a task by binding the stores/resolver and
 * delegating to the core chokepoint. Use this at every engine auto-merge trigger
 * gate that needs the verdict-aware / PR-mode routing (rather than the bare
 * `allowsAutoMergeProcessing` boolean).
 */
export async function resolveAutoMergeRoute(
  deps: AutoMergeGateEngineDeps,
  taskId: string,
  taskHint?: Task,
): Promise<ShouldAutoMergeResult> {
  const settings = (await (deps.getSettings ? deps.getSettings() : deps.store.getSettings())) ?? {};
  const task = taskHint ?? (await deps.store.getTask(taskId));

  const ir = await resolveWorkflowIrForTask(deps.store, taskId);
  const prMode = irIsPrMode(ir);
  const isCompanyBoard = isCompanyModelEnabled(settings) && isCompanyBoardIr(ir);

  let verdictStatus: ReviewerVerdictStatus;
  if (isCompanyBoard) {
    const verdict = deps.store.getTaskReviewerStore().getLatestVerdict(taskId);
    verdictStatus = toVerdictStatus(verdict?.status);
  }

  return shouldAutoMergeTask({
    task,
    settings: { autoMerge: (settings as Pick<Settings, "autoMerge">).autoMerge ?? false },
    prMode,
    isCompanyBoard,
    verdictStatus,
    hasManualApprovalMarker: hasManualApprovalMarker(task),
  });
}
