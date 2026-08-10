/**
 * FNXC:CodeOrganization 2026-08-03-20:55:
 * ensureWorkflowMergeBoundaryTask peeled from TaskExecutor (U4).
 * Establish durable merge-column handoff + graph-native checklist projection before merge.
 */
import type { RunMutationContext, TaskDetail, TaskStore } from "@fusion/core";
import { UNATTRIBUTED_MUTATION_CONTEXT } from "@fusion/core";
import { toRunMutationContext, type EngineRunContext } from "../util/run-audit.js";
import { resolveCompleteColumnFor } from "./lifecycle-columns.js";

export type WorkflowMergeBoundaryProof = {
  hasForeachStepExecute: boolean;
  complete: boolean;
  hasRelevantNodeResult: boolean;
  allResultsTerminal: boolean;
  nonTerminalResult?: { workflowStepId?: string; status?: string } | null;
  missingInstanceIds: string[];
};

export type WorkflowMergeBoundaryDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  runContextFor: (taskId: string, fallbackAgentId?: string | null) => import("@fusion/core").RunMutationContext;
  resolveMergeBoundaryColumn: (taskId: string, nodeId: string) => Promise<string>;
  evaluateWorkflowMergeBoundary: (
    live: TaskDetail,
    runId: string,
  ) => Promise<WorkflowMergeBoundaryProof>;
  shouldCompleteChecklistAtWorkflowMerge: (
    live: TaskDetail,
    mergeProof: WorkflowMergeBoundaryProof,
  ) => boolean;
};

export async function ensureWorkflowMergeBoundaryTask(
  deps: WorkflowMergeBoundaryDeps,
  task: TaskDetail,
  metadata: { reason: string; nodeId: string; workflowId: string; runId: string },
): Promise<TaskDetail> {
  let live = await deps.store.getTask(task.id);
  if (!live) return task;

  /*
  FNXC:WorkflowMerge 2026-07-19-04:10 (U5a / R1 / KTD-7):
  The merge NODE's OWN column drives the pre-merge handoff — not a hardcoded
  "in-review". builtin:coding places its merge-class nodes (merge-gate /
  merge-attempt / …) in `in-review`, so the default pipeline lands in `in-review`
  exactly as before (KTD-7 parity oracle). A user-authored workflow (the 6-column
  benchmark) places the merge node in `Merging`, so the card lands there because
  the IR says so — deleting the hardcoded-"in-review" +
  handoff-invariant-violation-allowlist assumption. Resolution failures fall back
  to `in-review` so a bad/unresolvable IR never strands the merge boundary.
  */
  const targetColumn = await deps.resolveMergeBoundaryColumn(task.id, metadata.nodeId);

  /*
  FNXC:WorkflowMerge 2026-07-26-22:59:
  A prior review handoff can move a graph-native workflow into its merge column before this boundary projects successful node results onto the legacy checklist. Preserve the no-move behavior, but do not return until the projection has run.
  */
  const alreadyAtMergeColumn = live.column === targetColumn;
  if (live.column === await resolveCompleteColumnFor(deps.store, live.id)) return live;
  if (live.paused || live.userPaused) return live;

  /*
  FNXC:WorkflowMerge 2026-06-29-10:15:
  User-authored workflows may legitimately route execution directly to a merge node without an explicit review node. Reaching that node is the workflow-owned merge boundary, so the engine must establish the durable in-review/merge lifecycle handoff before requesting merge instead of assuming a prior node already moved the card.

  FNXC:WorkflowMerge 2026-06-29-15:28:
  Compound Engineering and similar graph-native workflows execute skill nodes instead of legacy parsed task steps. The graph records those nodes as `workflowStepResults.source = "node"`; at the merge boundary, project a successful graph-native run onto the legacy checklist so `task has incomplete steps` cannot block a workflow that already completed its authoritative nodes.
  */
  const mergeProof = await deps.evaluateWorkflowMergeBoundary(live, metadata.runId);
  if (mergeProof.hasForeachStepExecute && !mergeProof.complete) {
    const reason = !mergeProof.hasRelevantNodeResult
      ? "no pre-merge node result recorded"
      : !mergeProof.allResultsTerminal
        ? `non-terminal pre-merge node result ${mergeProof.nonTerminalResult?.workflowStepId ?? "unknown"} (${mergeProof.nonTerminalResult?.status ?? "unknown"})`
        : `foreach step instances incomplete at merge boundary: missing ${mergeProof.missingInstanceIds.join(", ")}`;
    await deps.store.logEntry(live.id, `Workflow merge boundary blocked: ${reason}`, undefined, deps.runContextFor(live.id));
    return live;
  }

  if (deps.shouldCompleteChecklistAtWorkflowMerge(live, mergeProof)) {
    const completedSteps = live.steps.map((step) =>
      step.status === "done" || step.status === "skipped"
        ? step
        : { ...step, status: "done" as const },
    );
    const updated = await deps.store.updateTask(
      live.id,
      {
        steps: completedSteps,
        currentStep: Math.max(0, completedSteps.length - 1),
      } as Partial<TaskDetail>,
      deps.runContextFor(live.id),
    );
    live = (updated as TaskDetail | undefined) ?? { ...live, steps: completedSteps, currentStep: Math.max(0, completedSteps.length - 1) };
    await deps.store.logEntry(
      live.id,
      "Workflow merge boundary completed graph-native task checklist before requesting merge",
      undefined,
      deps.runContextFor(live.id),
    );
  }
  if (alreadyAtMergeColumn) return live;
  const moveOptions = {
    preserveProgress: true,
    moveSource: "engine" as const,
    workflowMoveSource: "workflow-graph",
    workflowMoveMetadata: metadata,
  };
  /*
  FNXC:Identity 2026-08-15-22:52 (U18/KTD2 — the seam restates the required context):
  This inline widening re-declares `moveTask` with `options?: unknown` and NO context parameter.
  Because it is an intersection over `this.store`, the narrow member wins at the call below, so a
  lifecycle move made here would stay unattributed even after every other executor call site is
  converted — a hole invisible to the census, inside the file that owns the most call sites. The
  shape now mirrors the CANONICAL store arity so the widening cannot weaken the requirement.
  */
  const runContext = deps.runContextFor(live.id);
  const mutationContext: RunMutationContext = runContext ? toRunMutationContext(runContext) : UNATTRIBUTED_MUTATION_CONTEXT;
  const storeWithMove = deps.store as typeof deps.store & {
    moveTask?: (id: string, column: string, options: unknown | undefined, runContext: RunMutationContext) => Promise<TaskDetail | undefined>;
  };
  if (typeof storeWithMove.moveTask === "function") {
    const moved = await storeWithMove.moveTask(live.id, targetColumn, moveOptions, mutationContext);
    await deps.store.logEntry(live.id, `Workflow merge boundary moved task to ${targetColumn} before requesting merge`, undefined, deps.runContextFor(live.id));
    return moved ?? { ...live, column: targetColumn };
  }
  await deps.store.updateTask(live.id, { column: targetColumn } as Partial<TaskDetail>, deps.runContextFor(live.id));
  await deps.store.logEntry(live.id, `Workflow merge boundary moved task to ${targetColumn} before requesting merge`, undefined, deps.runContextFor(live.id));
  return { ...live, column: targetColumn };
}
