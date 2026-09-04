import {
  getPostMergeFinalizeBlocker,
  planConfirmedMergeChecklistReconciliation,
  resolveWorkflowIrForTask,
  resolveCompleteColumn,
  resolveMergeOrchestrationColumn,
  columnHasFlag,
  clearMergeConfirmedTransientStatus,
  type MergeResult,
  type Task,
  type TaskStore,
} from "@fusion/core";
import { createRunAuditor, generateSyntheticRunId, type DatabaseMutationType, type RunAuditor } from "../util/run-audit.js";
import { cleanupLandedTaskWorktree } from "./post-landing-worktree-cleanup.js";
import type { MergeWriteFence } from "./merge-write-fence.js";

/*
FNXC:WorkflowMergeFinalization 2026-07-19-07:20 (U7 / R2/R3/KTD-1):
Finalization moves a confirmed-merged card to the workflow's COMPLETE-trait column
(not the literal "done"), and treats the merge-orchestration column (not literal
"in-review") as the normal pre-complete review column. builtin:coding resolves to
`done` / `in-review` so the default pipeline is byte-identical; a custom workflow
(the benchmark) lands in its own `Done` / `Merging` columns. Resolution failure
falls back to the legacy literals so a bad IR never strands a proven-merged task.
*/
async function resolveFinalizationColumns(
  store: TaskStore,
  taskId: string,
): Promise<{ completeColumn: string; mergeColumn: string; isCompleteColumn: (columnId: string) => boolean }> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    return {
      completeColumn: resolveCompleteColumn(ir) ?? "done",
      mergeColumn: resolveMergeOrchestrationColumn(ir) ?? "in-review",
      isCompleteColumn: (columnId: string) => columnHasFlag(ir, columnId, "complete"),
    };
  } catch {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:51 (DELIBERATE-LITERAL — the FAIL-SOFT arm of an
    already-converted resolver): the resolved path is the `try` above. This block runs only when the
    workflow IR cannot be read at all, and its whole job is to answer with the built-in vocabulary so
    finalization keeps working rather than throwing. Resolving here is impossible by construction —
    the resolver is what just failed — so this is not pending conversion work and is marked instead of
    being left to re-offer itself as available on every census.
    */
    return {
      completeColumn: "done",
      mergeColumn: "in-review",
      /* DELIBERATE-LITERAL — the degraded fallback arm; the live arm above calls `columnHasFlag`.
         Reached only when IR resolution throws, where the legacy id is the only answer left. */
      isCompleteColumn: (columnId: string) => columnId === "done",
    };
  }
}

/*
FNXC:WorkflowMergeFinalization 2026-07-19-09:40 (R2/R7b):
The transition-race classifier must match the workflow's resolved COMPLETE column,
not the literal "done". moveTask targets the resolved completeColumn, so a race
error for a custom complete column (e.g. the benchmark's "shipped") says
"→ 'shipped'"; hardcoding "→ 'done'" skipped the already-done recovery branch and
rethrew, stranding a proven-merged task. Default stays "done" for builtin:coding
and legacy fallbacks.
*/
export function isInvalidDoneTransitionError(error: unknown, targetColumn = "done"): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Invalid transition:") && message.includes(`→ '${targetColumn}'`);
}

export interface AutoMergeFinalizationResult {
  outcome: "done" | "already-done" | "blocked" | "missing";
  task: Task | null;
  previousColumn: string | null;
  reason?: string;
}

export interface FinalizeProvenAutoMergeTaskOptions {
  store: TaskStore;
  taskId: string;
  result?: MergeResult;
  rootDir?: string;
  audit?: RunAuditor;
  auditAgentId?: string;
  auditPhase?: string;
  source: "direct-ai-merge" | "merge-confirmed-fast-path" | "self-healing" | "workflow-graph-merge-finalize";
  log?: (message: string) => void | Promise<void>;
  fence?: MergeWriteFence;
}

export type WorkflowDoneMergeProofVerdict =
  | { ok: true }
  | { ok: false; reason: string; metadata?: Record<string, unknown> };

function mergeProofLandedFiles(task: Task, result?: MergeResult): string[] {
  const files = result?.landedFiles ?? task.mergeDetails?.landedFiles ?? [];
  return Array.from(new Set(files.map((file) => file.trim()).filter(Boolean)));
}

function hasIncompleteWorkflowSteps(task: Task): boolean {
  return (task.steps ?? []).some((step) => step.status !== "done" && step.status !== "skipped");
}

export async function validateWorkflowDoneMergeProof(
  task: Task,
  options: {
    result?: MergeResult;
    checkWorkflowSteps?: boolean;
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:20:
    The RESOLVED complete test, supplied by the caller. Omitted → the `done` literal, i.e. today's
    behaviour, which is the same default-to-legacy contract the lane-parameter vocabulary uses
    elsewhere. `resolveFinalizationColumns` in this file already builds exactly this predicate for
    its own guard; the two callers below now hand it down instead of re-asking with an id.
    */
    isCompleteColumn?: (columnId: string) => boolean;
  } = {},
): Promise<WorkflowDoneMergeProofVerdict> {
  const hasProof = hasDurableMergeProof(task, options.result);
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:25 (the deferral is now paid — see the note above):
  This literal selects which REASON STRING is reported, not which branch runs. Both arms return
  `{ ok: false }`, so on a renamed board a card sitting in the complete lane was refused with the
  generic `missing-merge-confirmation` instead of the specific `done-without-merge-confirmation`.

  The earlier note recorded this as "REAL but DIAGNOSTIC-ONLY" and declined it on the grounds that
  widening a signature to improve an error string is a poor trade. That undersold the consequence:
  this reason is not a log line. It is asserted as run-audit metadata alongside `previousColumn`
  (`merger-merge-lifecycle.test.ts`), so the audit trail — the record an operator reads to find out
  why a merge was refused — carried the wrong classification for every renamed board.

  The trade is also cheaper than it looked. This function is ALREADY async and ALREADY takes an
  options bag, and `resolveFinalizationColumns` two functions up ALREADY builds this exact predicate
  for its own guard. Nothing new is resolved; the answer that existed is handed down instead of
  being re-asked with an id — which is the half-conversion shape this program keeps finding, here
  within one file.
  */
  /* DELIBERATE-LITERAL: the fallback arm of the conversion described directly above — reached only
     when a caller passes no resolved predicate. The resolved path is `options.isCompleteColumn`. */
  const isCompleteLane = options.isCompleteColumn ? options.isCompleteColumn(task.column) : task.column === "done";
  if (!hasProof) return { ok: false, reason: isCompleteLane ? "done-without-merge-confirmation" : "missing-merge-confirmation" };
  if (options.checkWorkflowSteps !== false && hasIncompleteWorkflowSteps(task)) {
    return { ok: false, reason: "incomplete-workflow-steps" };
  }

  const noOp = options.result?.noOp === true || task.mergeDetails?.noOpMerge === true;
  const landedFiles = mergeProofLandedFiles(task, options.result);
  if (noOp && landedFiles.length > 0) {
    return { ok: false, reason: "noop-merge-with-landed-files", metadata: { landedFiles: landedFiles.length } };
  }
  /*
   * FNXC:AutoMergeFinalization 2026-07-01-10:22:
   * Finalization cares whether the task patch landed on the integration branch, not whether the task branch history is clean after squash merges. Historical task branches can retain patch-equivalent foreign commits whose SHAs are not ancestors of main; once durable merge proof exists, branch residue must not strand the task in review.
   */

  return { ok: true };
}

function buildMismatchMetadata(task: Task, reason: string): Record<string, unknown> {
  return {
    taskId: task.id,
    previousColumn: task.column,
    targetColumn: "done",
    commitSha: task.mergeDetails?.commitSha ?? null,
    status: task.status ?? null,
    blockedBy: task.blockedBy ?? null,
    overlapBlockedBy: task.overlapBlockedBy ?? null,
    reason,
  };
}

async function recordFinalizationAudit(args: {
  store: TaskStore;
  audit?: RunAuditor;
  task: Task;
  type: DatabaseMutationType;
  reason: string;
  auditAgentId?: string;
  auditPhase?: string;
}): Promise<void> {
  try {
    const auditor = args.audit ?? createRunAuditor(args.store, {
      runId: generateSyntheticRunId("auto-merge-finalize", args.task.id),
      agentId: args.auditAgentId ?? "merger",
      taskId: args.task.id,
      taskLineageId: args.task.lineageId,
      phase: args.auditPhase ?? "auto-merge-finalize",
    });
    await auditor.database({
      type: args.type,
      target: args.task.id,
      metadata: buildMismatchMetadata(args.task, args.reason),
    });
  } catch {
    // Best effort: audit persistence must never strand a proven landed task.
  }
}

function buildFinalizationMergeDetails(task: Task, result?: MergeResult): NonNullable<Task["mergeDetails"]> {
  const mergedAt = task.mergeDetails?.mergedAt ?? new Date().toISOString();
  /*
   * FNXC:WorkflowMerge 2026-06-29-09:04:
   * Workflow graph merge finalization must never promote loose `merged:true` or `noOp:true` results into durable merge proof. A task can reach `done` only when the merger records `mergeConfirmed:true`; otherwise replay/recovery must block so the branch is merged instead of bypassed.
   */
  const mergeConfirmed =
    result?.mergeConfirmed === true || task.mergeDetails?.mergeConfirmed === true;
  return {
    ...(task.mergeDetails ?? {}),
    ...(result?.commitSha ? { commitSha: result.commitSha } : {}),
    ...(result?.rebaseBaseSha ? { rebaseBaseSha: result.rebaseBaseSha } : {}),
    ...(result?.landedFiles ? { landedFiles: result.landedFiles } : {}),
    ...(typeof result?.filesChanged === "number" ? { filesChanged: result.filesChanged } : {}),
    ...(typeof result?.insertions === "number" ? { insertions: result.insertions } : {}),
    ...(typeof result?.deletions === "number" ? { deletions: result.deletions } : {}),
    ...(result?.mergeCommitMessage ? { mergeCommitMessage: result.mergeCommitMessage } : {}),
    mergedAt,
    mergeConfirmed,
    ...(result?.noOp && mergeConfirmed ? { noOpMerge: true, noOpReason: result.reason } : {}),
  };
}

function hasDurableMergeProof(task: Task, result?: MergeResult): boolean {
  return task.mergeDetails?.mergeConfirmed === true || result?.mergeConfirmed === true;
}

/**
 * FNXC:AutoMergeLifecycle 2026-06-22-19:28:
 * Proven auto-merge completion must refresh the authoritative row before moving to done because the merge CAS and queue retry paths can leave a landed task in todo with stale queued/overlap state. Use TaskStore recovery rehome for those column mismatches so completion remains idempotent without direct database surgery.
 */
export async function finalizeProvenAutoMergeTask({
  store,
  taskId,
  result,
  rootDir,
  audit,
  auditAgentId,
  auditPhase,
  source,
  log,
  fence,
}: FinalizeProvenAutoMergeTaskOptions): Promise<AutoMergeFinalizationResult> {
  const latest = await store.getTask(taskId).catch(() => null);
  if (!latest) {
    return { outcome: "missing", task: null, previousColumn: null, reason: "task-not-found" };
  }

  // U7: resolve the workflow's complete/merge columns once (byte-identical to
  // done/in-review for builtin:coding).
  const { completeColumn, mergeColumn, isCompleteColumn } = await resolveFinalizationColumns(store, taskId);

  const validationMergeDetails = buildFinalizationMergeDetails(latest, result);
  const cleanupLandedWorktree = async (task: Task, mergeDetails: NonNullable<Task["mergeDetails"]>): Promise<void> => {
    if (!rootDir) return;
    await cleanupLandedTaskWorktree({
      store,
      taskId,
      worktreePath: task.worktree,
      rootDir,
      landedSha: mergeDetails.commitSha ?? result?.commitSha,
      source,
      audit,
      log: async (message) => {
        if (fence) {
          await fence.write("log", () => store.logEntry(taskId, message).catch(() => undefined));
        } else {
          await store.logEntry(taskId, message).catch(() => undefined);
        }
        await log?.(message);
      },
      fence,
    });
  };
  /*
   * FNXC:WorkflowMerge 2026-06-29-10:35:
   * Workflow-owned completion requires current merge proof, not just a stale `mergeConfirmed` flag. A task cannot reach or remain accepted as `done` when workflow steps are still pending or a no-op claims landed files. Branch-only residue is ignored because squash landing validates the task patch, not branch-history cleanliness.
   */
  if (isCompleteColumn(latest.column)) {
    const proofVerdict = await validateWorkflowDoneMergeProof({ ...latest, mergeDetails: validationMergeDetails } as Task, { result, isCompleteColumn });
    if (!proofVerdict.ok) {
      await recordFinalizationAudit({
        store,
        audit,
        task: latest,
        type: "task:auto-merge-finalize-column-mismatch-no-action",
        reason: proofVerdict.reason,
        auditAgentId,
        auditPhase,
      });
      await log?.(`Auto-merge finalization blocked for ${taskId}: ${proofVerdict.reason}`);
      return { outcome: "blocked", task: latest, previousColumn: latest.column, reason: proofVerdict.reason };
    }
    /*
    FNXC:WorkflowMergeFinalization 2026-08-29-01:06:
    This is convergence, not the ordering gate: a task that reached complete before FN-251 still
    receives proof-gated cleanup when the finalizer sees its durable landing again. No root directory
    means there is no trustworthy cleanup boundary, so preserve the historical no-op finalization.
    */
    await cleanupLandedWorktree(latest, validationMergeDetails);
    const converged = await store.getTask(taskId).catch(() => latest);
    if (result) result.task = converged;
    return { outcome: "already-done", task: converged, previousColumn: latest.column };
  }

  const mergeDetails = validationMergeDetails;
  const hasProof = hasDurableMergeProof({ ...latest, mergeDetails } as Task, result);
  if (!hasProof) {
    const reason = "missing-merge-confirmation";
    await recordFinalizationAudit({
      store,
      audit,
      task: latest,
      type: "task:auto-merge-finalize-column-mismatch-no-action",
      reason,
      auditAgentId,
      auditPhase,
    });
    return { outcome: "blocked", task: latest, previousColumn: latest.column, reason };
  }

  /*
  FNXC:ConfirmedMergeFinalization 2026-08-23-07:25:
  FN-180 forbids re-running the pre-merge checklist after durable merge proof.
  A concurrent review bounce can leave that checklist stale, so reconcile it
  before moving to complete; only an independent status may still defer.
  */
  const postMergeBlocker = getPostMergeFinalizeBlocker({
    status: clearMergeConfirmedTransientStatus(latest.status),
    error: undefined,
  });
  if (postMergeBlocker) {
    await recordFinalizationAudit({
      store,
      audit,
      task: latest,
      type: "task:auto-merge-finalize-column-mismatch-no-action",
      reason: postMergeBlocker,
      auditAgentId,
      auditPhase,
    });
    return { outcome: "blocked", task: latest, previousColumn: latest.column, reason: postMergeBlocker };
  }
  const checklistReconciliation = planConfirmedMergeChecklistReconciliation(latest);
  const reconciledSteps = latest.steps.map((step, index) =>
    checklistReconciliation.skippedStepIndexes.includes(index) ? { ...step, status: "skipped" as const } : step,
  );
  const reconciledWorkflowStepResults = (latest.workflowStepResults ?? []).map((result) =>
    checklistReconciliation.reconciledWorkflowStepIds.includes(result.workflowStepId)
      ? { ...result, status: "skipped" as const }
      : result,
  );

  const proofVerdict = await validateWorkflowDoneMergeProof({ ...latest, mergeDetails } as Task, {
    result,
    checkWorkflowSteps: false,
    isCompleteColumn,
  });
  if (!proofVerdict.ok) {
    await recordFinalizationAudit({
      store,
      audit,
      task: latest,
      type: "task:auto-merge-finalize-column-mismatch-no-action",
      reason: proofVerdict.reason,
      auditAgentId,
      auditPhase,
    });
    await log?.(`Auto-merge finalization blocked for ${taskId}: ${proofVerdict.reason}`);
    return { outcome: "blocked", task: latest, previousColumn: latest.column, reason: proofVerdict.reason };
  }

  fence?.assertOwned("finalization");
  await store.updateTask(taskId, {
    paused: false,
    status: null,
    error: null,
    blockedBy: null,
    overlapBlockedBy: null,
    mergeRetries: 0,
    mergeDetails,
    steps: reconciledSteps,
    workflowStepResults: reconciledWorkflowStepResults,
  } as Pick<Task, "steps" | "workflowStepResults">);

  const shouldRecoveryRehome = latest.column !== mergeColumn;
  if (shouldRecoveryRehome) {
    await log?.(
      `Auto-merge finalization repairing ${taskId}: authoritative row is ${latest.column}; clearing stale lifecycle blockers and moving to ${completeColumn}`,
    );
  }

  /*
  FNXC:WorkflowMergeFinalization 2026-08-29-01:06:
  For a proven single-repository landing, resolve cleanup before the complete-column move. Preserved
  deliverable, unverifiable, and active-session outcomes are logged but never reclassify a durable
  landing as a merge failure, because blocking this transition would permanently wedge the card.
  */
  await cleanupLandedWorktree(latest, mergeDetails);

  try {
    fence?.assertOwned("finalization");
    /*
    FNXC:AutoMergeMoveAttribution 2026-08-29-07:37:
    Proven merge finalization advances review to the complete lane. Use a dedicated neutral
    provenance instead of workflow-graph, workflow-remediation, or plan-approval: those literals
    carry in-review-entry and reopen semantics. The value is also forwarded to plugin move policies.
    */
    const moved = await store.moveTask(taskId, completeColumn, shouldRecoveryRehome
      ? { moveSource: "engine", workflowMoveSource: "auto-merge-finalization", recoveryRehome: true, preserveProgress: true }
      : { moveSource: "engine", workflowMoveSource: "auto-merge-finalization", preserveProgress: true });
    if (result) result.task = moved;
    if (shouldRecoveryRehome) {
      await recordFinalizationAudit({
        store,
        audit,
        task: latest,
        type: "task:auto-merge-finalize-column-mismatch-reconciled",
        reason: `${source}:recovery-rehome`,
        auditAgentId,
        auditPhase,
      });
      fence?.assertOwned("finalization");
      await store.logEntry(
        taskId,
        `Auto-merge finalization repaired column mismatch: ${latest.column} → ${completeColumn} after proven merge; cleared stale status/blockers`,
      ).catch(() => undefined);
    }
    const finalTask = moved ?? (await store.getTask(taskId).catch(() => null)) ?? latest;
    return { outcome: shouldRecoveryRehome ? "done" : "done", task: finalTask, previousColumn: latest.column };
  } catch (error) {
    if (isInvalidDoneTransitionError(error, completeColumn)) {
      const refreshed = await store.getTask(taskId).catch(() => null);
      if (refreshed && isCompleteColumn(refreshed.column)) {
        if (result) result.task = refreshed;
        return { outcome: "already-done", task: refreshed, previousColumn: latest.column };
      }
      if (refreshed) {
        await recordFinalizationAudit({
          store,
          audit,
          task: refreshed,
          type: "task:auto-merge-finalize-column-mismatch-no-action",
          reason: `invalid-done-transition:${refreshed.column}`,
          auditAgentId,
          auditPhase,
        });
      }
    }
    throw error;
  }
}
