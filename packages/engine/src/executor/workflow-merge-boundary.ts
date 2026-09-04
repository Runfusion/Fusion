/**
 * FNXC:CodeOrganization 2026-08-03-20:55:
 * ensureWorkflowMergeBoundaryTask peeled from TaskExecutor (U4).
 * Establish durable merge-column handoff + graph-native checklist projection before merge.
 */
import type { RunMutationContext, TaskDetail, TaskStore } from "@fusion/core";
import { hasNonTerminalSteps } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import { runContextForTotal } from "./run-context-for.js";
import { resolveCompleteColumnFor } from "./lifecycle-columns.js";

export type WorkflowMergeBoundaryProof = {
  hasForeachStepExecute: boolean;
  complete: boolean;
  hasRelevantNodeResult: boolean;
  allResultsTerminal: boolean;
  hasLiveStepImplementationProof: boolean;
  nonTerminalResult?: { workflowStepId?: string; status?: string } | null;
  missingInstanceIds: string[];
};

export type MergeBoundaryUnprovenReasonCode =
  | "no-node-result"
  | "non-terminal-node-result"
  | "missing-foreach-instances";

export type WorkflowMergeBoundaryResult = {
  task: TaskDetail;
  blocked?: {
    reason: string;
    code: MergeBoundaryUnprovenReasonCode;
    missingInstanceCount: number;
  };
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
): Promise<WorkflowMergeBoundaryResult> {
  let live = await deps.store.getTask(task.id);
  if (!live) return { task };

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
  if (live.column === await resolveCompleteColumnFor(deps.store, live.id)) return { task: live };
  if (live.paused || live.userPaused) return { task: live };

  /*
  FNXC:WorkflowMerge 2026-06-29-10:15:
  User-authored workflows may legitimately route execution directly to a merge node without an explicit review node. Reaching that node is the workflow-owned merge boundary, so the engine must establish the durable in-review/merge lifecycle handoff before requesting merge instead of assuming a prior node already moved the card.

  FNXC:WorkflowMerge 2026-06-29-15:28:
  Compound Engineering and similar graph-native workflows execute skill nodes instead of legacy parsed task steps. The graph records those nodes as `workflowStepResults.source = "node"`; at the merge boundary, project a successful graph-native run onto the legacy checklist so `task has incomplete steps` cannot block a workflow that already completed its authoritative nodes.
  */
  /*
  FNXC:WorkflowMerge 2026-08-20-00:50:
  FN-9157 permits merge admission from complete terminal live foreach coverage
  when Review Level 0 has deliberately disabled optional node-recording groups.
  The proof still excludes zero expected instances and any pending step; checklist
  projection continues to depend only on proof.complete.
  */
  const mergeProof = await deps.evaluateWorkflowMergeBoundary(live, metadata.runId);
  /*
  FNXC:WorkflowMerge 2026-08-26-13:05:
  A TASK THAT LEGITIMATELY PRODUCED NOTHING HAS NOTHING TO PROVE.

  This proof asks "did the planned implementation actually run" and refuses the boundary when a
  foreach step-execute region left no terminal node result. That is right for work that was supposed
  to happen. It is meaningless for a task whose accepted outcome is that no work happens at all — a
  verified duplicate or an authorized no-commit decision — because there is no implementation whose
  absence could be suspicious.

  Measured on a live card: MULT-024 was closed through the duplicate sentinel ("explicitly duplicates
  MULT-010; implementation should not proceed", recorded as no commits expected). Its Code Review had
  nothing to read and finished in 265ms without recording a result, so the boundary found no node
  result and terminalized the card with `merge-boundary-unproven — operator action required`. A task
  that did exactly what was asked ended as an error demanding human rescue.

  The exemption is deliberately narrow: `noCommitsExpected` is set by an authorized terminal decision,
  and every step must already be settled, so a card with pending work still faces the full proof. It
  waives only THIS structural proof — pre-merge approval, blocking statuses and the no-op finalize
  guard (which still refuses a SKIPPED verification step over an empty diff, FN-8141) all continue to
  apply at the merge door itself.
  */
  /* `hasNonTerminalSteps` is the shared rule behind the merge door's own "incomplete steps" refusal,
     so this exemption cannot drift from what the door considers unfinished work. */
  const noCommitsExpectedTerminal = live.noCommitsExpected === true && !hasNonTerminalSteps(live);
  if (noCommitsExpectedTerminal && mergeProof.hasForeachStepExecute && !mergeProof.complete) {
    await deps.store.logEntry(
      live.id,
      "Workflow merge boundary: no implementation proof required — task is an authorized no-commit outcome",
      undefined,
      deps.getRunContextFor(live.id),
    );
  }
  if (!noCommitsExpectedTerminal && mergeProof.hasForeachStepExecute && !mergeProof.complete) {
    const blocked = !mergeProof.hasRelevantNodeResult
      ? { reason: "no pre-merge node result recorded", code: "no-node-result" as const }
      : !mergeProof.allResultsTerminal
        ? {
            reason: `non-terminal pre-merge node result ${mergeProof.nonTerminalResult?.workflowStepId ?? "unknown"} (${mergeProof.nonTerminalResult?.status ?? "unknown"})`,
            code: "non-terminal-node-result" as const,
          }
        : {
            reason: `foreach step instances incomplete at merge boundary: missing ${mergeProof.missingInstanceIds.join(", ")}`,
            code: "missing-foreach-instances" as const,
          };
    /*
    FNXC:RunAudit 2026-08-20-02:00:
    Boundary reason prose can contain foreach instance IDs and node-result status text. Run-audit
    metadata must remain ids/counts/outcomes-only, so terminal parks receive this closed code and
    missing-instance count rather than this human-readable reason.
    */
    await deps.store.logEntry(live.id, `Workflow merge boundary blocked: ${blocked.reason}`, undefined, deps.runContextFor(live.id));
    return {
      task: live,
      blocked: { ...blocked, missingInstanceCount: mergeProof.missingInstanceIds.length },
    };
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
  if (alreadyAtMergeColumn) return { task: live };
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
  const storeWithMove = deps.store as typeof deps.store & {
    /*
    FNXC:Identity 2026-08-15-22:52:
    The local structural type carries the context parameter so this move is attributed like every
    other write in this file. It was the one call here that still used the context-free shape, so the
    merge-boundary move audited as `system`/`unknown` while the log entries on either side of it
    carried the real actor.
    */
    moveTask?: (
      id: string,
      column: string,
      options?: unknown,
      context?: RunMutationContext,
    ) => Promise<TaskDetail | undefined>;
  };
  if (typeof storeWithMove.moveTask === "function") {
    /*
    FNXC:Identity 2026-08-24-02:18:
    PR 3430 review (Greptile P1 / CodeRabbit major): a three-argument `moveTask` here audited as
    `system`/`unknown` while the adjacent log used the live run. Pass the same total carrier as the
    follow-up log so the merge-column move is attributable.
    */
    const mergeMoveContext = runContextForTotal(deps.getRunContextFor, live.id);
    const moved = await storeWithMove.moveTask(
      live.id,
      targetColumn,
      moveOptions,
      mergeMoveContext,
    );
    await deps.store.logEntry(live.id, `Workflow merge boundary moved task to ${targetColumn} before requesting merge`, undefined, mergeMoveContext);
    return { task: moved ?? { ...live, column: targetColumn } };
  }
  await deps.store.updateTask(live.id, { column: targetColumn } as Partial<TaskDetail>, deps.runContextFor(live.id));
  await deps.store.logEntry(live.id, `Workflow merge boundary moved task to ${targetColumn} before requesting merge`, undefined, deps.runContextFor(live.id));
  return { task: { ...live, column: targetColumn } };
}
