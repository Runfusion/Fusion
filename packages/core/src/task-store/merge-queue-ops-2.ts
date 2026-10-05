import { emitBoundedRunAudit } from "../run-audit/emit-bounded-run-audit.js";
/* FNXC:RunAudit 2026-08-20-05:49: FN-9177 bounds optional audit telemetry so a hostile sink cannot alter this lifecycle path. */
/**
 * merge-queue-ops-2 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import type {Task, Column, MergeResult, MergeQueueReleaseOutcome, MergeRequestState} from "../types.js";
import "../builtin-traits.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {releaseMergeQueueLease as releaseMergeQueueLeaseAsync} from "../task-store/async/async-merge-coordination.js";
import {resolveTaskLifecycleColumns} from "../workflows/workflow-lifecycle-traits.js";

export function isValidMergeRequestTransitionImpl(store: TaskStore, from: MergeRequestState, to: MergeRequestState): boolean {
    if (from === to) return true;
    const allowed: Record<MergeRequestState, ReadonlySet<MergeRequestState>> = {
      queued: new Set(["running", "cancelled"]),
      running: new Set(["retrying", "succeeded", "exhausted", "cancelled"]),
      retrying: new Set(["queued", "cancelled", "exhausted"]),
      succeeded: new Set([]),
      exhausted: new Set([]),
      cancelled: new Set([]),
      "manual-required": new Set(["succeeded", "cancelled"]),
    };
    return allowed[from].has(to);
  }

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-10:00 (u12 — DELETED, not converted):
`enqueueMergeQueueSyncInternalImpl` and its `store.enqueueMergeQueueSyncInternal` entry point are gone.
Merge-queue enqueue is PostgreSQL-only via `enqueueMergeQueueAsync` (task-artifacts-ops.ts); the sync
SQLite arm had ZERO callers — every remaining mention was a comment. Its `column !== "in-review"` guard
was carried in the census as deferred debt "needing a store-architecture change to convert". It needed
no conversion: the code it guarded was unreachable on the shipped backend. Removing dead code is why the
count drops here, so do not read this file's 0 as a converted seam.
*/
export async function releaseMergeQueueLeaseImpl(store: TaskStore, taskId: string, workerId: string, outcome: MergeQueueReleaseOutcome): Promise<void> {
        const layer = store.asyncLayer!;
    return releaseMergeQueueLeaseAsync(layer, taskId, workerId, outcome);
}

export async function collectMergeDetailsImpl(store: TaskStore, _id: string, _branch: string, task: Task, commitMessage: string, mergeTarget?: { branch: string; source: "task-base-branch" | "task-branch-context" | "branch-group-integration" | "project-default" | "legacy-main"; },): Promise<import("../types.js").MergeDetails> {
    const mergedAt = new Date().toISOString();
    let commitSha: string | undefined;
    let filesChanged: number | undefined;
    let insertions: number | undefined;
    let deletions: number | undefined;
    let landedFiles: string[] | undefined;

    const headResult = await store.runGitCommand("git rev-parse HEAD");
    if (headResult.exitCode === 0) {
      commitSha = headResult.stdout.trim() || undefined;
    } else {
      commitSha = undefined;
    }

    const statsResult = await store.runGitCommand("git show --shortstat --format= HEAD");
    if (statsResult.exitCode === 0) {
      const statsOutput = statsResult.stdout.trim();
      const normalized = statsOutput.replace(/\n/g, " ");
      const filesMatch = normalized.match(/(\d+) files? changed/);
      const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
      const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);
      filesChanged = filesMatch ? Number.parseInt(filesMatch[1], 10) : 0;
      insertions = insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0;
      deletions = deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0;
    } else {
      filesChanged = undefined;
      insertions = undefined;
      deletions = undefined;
    }

    if (commitSha) {
      const landedFilesResult = await store.runGitCommand(`git show --name-only --format= "${commitSha}"`);
      if (landedFilesResult.exitCode === 0) {
        const parsedLandedFiles = landedFilesResult.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (parsedLandedFiles.length > 0) {
          landedFiles = Array.from(new Set(parsedLandedFiles));
        }
      }
    }

    return {
      commitSha,
      landedFiles,
      filesChanged,
      insertions,
      deletions,
      mergeCommitMessage: commitMessage,
      mergedAt,
      mergeConfirmed: true,
      prNumber: task.prInfo?.number,
      mergeTargetBranch: mergeTarget?.branch,
      mergeTargetSource: mergeTarget?.source,
      resolutionStrategy: task.mergeDetails?.resolutionStrategy,
      resolutionMethod: task.mergeDetails?.resolutionMethod,
      attemptsMade: task.mergeDetails?.attemptsMade,
      autoResolvedCount: task.mergeDetails?.autoResolvedCount,
    };
  }

export async function applyPrMergedTransitionImpl(store: TaskStore, taskId: string, ctx?: { agentId?: string; runId?: string; externallyLanded?: boolean; lifecycleLockHeld?: boolean },): Promise<{ moved: boolean; skipped?: "already-done" | "not-merged" | "wrong-column" | "paused" | "no-complete-column" }> {
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-02-10:20 (fleet: the PR-merged transition):
    The conditional move supplies ONE LOCKED LIVE ROW for evidence checks and the move target. Earlier
    versions read twice around separate writes, allowing two observers to independently decide that they
    had completed the same task before either move became visible.

    On a renamed board every one of those answered wrong in the same direction: `column === "done"` never
    matched, so an already-complete card was not skipped as `already-done`; `column !== "in-review"` always
    matched, so the transition bailed with `wrong-column` for a card sitting in review. The net effect is
    that a PR merged on GitHub never advanced the card — the visible symptom is a merged PR whose Fusion
    task stays in review forever, which reads as a webhook problem rather than a column problem.

    The move target comes from the same snapshot: converting the guards alone would admit the card and then
    move it to a column the board does not declare, which is the half-conversion this program keeps paying
    for. A board with no complete column refuses the transition instead of inventing one.
    */
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-02-14:10 (PR #2733 review — greptile P1, and my COMMENT contradicted
    my CODE):
    A WORKFLOW THAT DECLARES COLUMNS BUT NO COMPLETE LANE REFUSES, it does not fall back to `done`. My first
    version wrote `?? "done"` while the comment above it claimed the transition refuses rather than inventing
    a column — the reviewer read the code, not the prose, and was right. `moveTask` would have rejected the
    undeclared `done` and left the merged card in review, which is the exact failure this conversion exists to
    prevent, reintroduced by a two-character default.

    The distinction is `PlannerLanes`' contract, and it is the one the whole program keeps re-learning:
      - NO LANE INFORMATION AT ALL (v1 IR, unresolvable store) -> the legacy ids ARE the answer; nothing has
        told us otherwise and today's behaviour is correct.
      - LANES RESOLVED, complete ABSENT -> the board genuinely has no completion column. Substituting one
        invents a destination; refusing is the honest outcome and is visible in the return value.
    */
    const prMergedLifecycle = await resolveTaskLifecycleColumns(store, taskId);
    const reviewColumn = prMergedLifecycle?.review ?? "in-review";
    const completeColumn = prMergedLifecycle ? prMergedLifecycle.complete : "done";
    if (completeColumn === undefined) {
      storeLog.warn(`[store] applyPrMergedTransition skipped for ${taskId}: workflow declares no complete column`);
      return { moved: false, skipped: "no-complete-column" };
    }
    let skipped: "already-done" | "not-merged" | "wrong-column" | "paused" | undefined;
    let reconciledTask: Task | undefined;

    /*
    FNXC:ExternalPrReconciliation 2026-09-29-06:24:
    Separate dashboard and engine stores can observe the same external merge concurrently. Use the
    project-scoped PostgreSQL advisory lock before moveTaskIf re-reads and transitions the task, so only
    one observer emits completion telemetry; the loser sees the committed complete lane and is a no-op.
    */
    const transitionWhileLifecycleLocked = async () => {
      const transition = await store.moveTaskIf(taskId, completeColumn as Column, async (live) => {
        if (live.column === completeColumn) {
          skipped = "already-done";
          return false;
        }
        if (live.paused) {
          skipped = "paused";
          return false;
        }
        if (live.prInfo?.status !== "merged") {
          skipped = "not-merged";
          return false;
        }
        if (live.column !== reviewColumn && ctx?.externallyLanded !== true) {
          storeLog.warn(`[store] applyPrMergedTransition skipped for ${taskId}: column=${live.column}`);
          skipped = "wrong-column";
          return false;
        }

        // A forge-confirmed merge is landing evidence, never a fabricated pre-merge review approval.
        const existing = live.mergeDetails;
        const mergeDetails = {
          ...existing,
          mergeConfirmed: true,
          prNumber: existing?.prNumber ?? live.prInfo.number,
          ...(existing?.commitSha || !live.prInfo.mergeCommitSha ? {} : { commitSha: live.prInfo.mergeCommitSha }),
          ...(existing?.mergedAt || !live.prInfo.mergedAt ? {} : { mergedAt: live.prInfo.mergedAt }),
        };
        const changed = existing?.mergeConfirmed !== true
          || (!existing?.commitSha && Boolean(live.prInfo.mergeCommitSha))
          || (!existing?.mergedAt && Boolean(live.prInfo.mergedAt))
          || (!existing?.prNumber && Boolean(live.prInfo.number));
        if (changed) {
          await store.updateTaskUnlocked(taskId, { mergeDetails });
          // moveTaskInternal persists this locked snapshot; retain the just-written evidence.
          live.mergeDetails = mergeDetails;
          reconciledTask = live;
        } else {
          reconciledTask = live;
        }
        return true;
      }, {
      moveSource: "engine",
      preserveProgress: true,
      preserveWorktree: true,
      // Only fresh provider proof may complete a stale non-review card; ordinary PR mirrors retain review guards.
      bypassGuards: ctx?.externallyLanded === true,
    });

      if (!transition.moved) {
        return { moved: false, skipped: skipped ?? "already-done" };
      }
      const movedTask = transition.task;
      const freshTask = reconciledTask ?? movedTask;

      store.emit("task:merged", {
        task: movedTask,
        branch: movedTask.branch ?? movedTask.prInfo?.headBranch ?? freshTask.branch ?? freshTask.prInfo?.headBranch ?? "",
        merged: true,
        worktreeRemoved: false,
        branchDeleted: false,
        mergeConfirmed: movedTask.mergeDetails?.mergeConfirmed ?? freshTask.mergeDetails?.mergeConfirmed,
        mergedAt: movedTask.mergeDetails?.mergedAt ?? freshTask.mergeDetails?.mergedAt,
        mergeTargetBranch: movedTask.mergeDetails?.mergeTargetBranch ?? freshTask.mergeDetails?.mergeTargetBranch,
        mergeTargetSource: movedTask.mergeDetails?.mergeTargetSource ?? freshTask.mergeDetails?.mergeTargetSource,
      } satisfies MergeResult);

      if (ctx?.agentId && ctx?.runId) {
        void emitBoundedRunAudit(store, {
          taskId,
          agentId: ctx.agentId,
          runId: ctx.runId,
          domain: "database",
          mutationType: "pr:merged-auto-done",
          target: taskId,
          metadata: {
            taskId,
            prNumber: freshTask.prInfo?.number,
            mergeMethod: freshTask.prInfo?.autoMergeStrategy,
          },
        });
      }

      return { moved: true };
    };

    /*
    FNXC:ExternalPrCloseout 2026-10-05-04:07:
    Callers that already hold the project-scoped lifecycle advisory lock must not
    reacquire it: PostgreSQL advisory locks are session-scoped and the nested wait
    would deadlock the handoff that established the proof.
    */
    return ctx?.lifecycleLockHeld
      ? transitionWhileLifecycleLocked()
      : store.withPlanningLifecycleLock(taskId, transitionWhileLifecycleLocked);
  }

