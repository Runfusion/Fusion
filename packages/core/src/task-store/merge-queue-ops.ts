/**
 * merge-queue-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import {InvalidMergeQueueLeaseDurationError} from "./errors.js";
import {existsSync} from "node:fs";
import type {Task, MergeResult, MergeQueueEntry, MergeQueueAcquireOptions} from "../types.js";
import {assertNotWorkspaceTaskMerge} from "../types.js";
import "../builtin-traits.js";
import {getTaskMergeBlocker, resolveTaskMergeTarget} from "../task-merge.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {assertSafeGitBranchName, assertSafeAbsolutePath} from "../task-store/shell-safety.js";
import {acquireMergeQueueLease as acquireMergeQueueLeaseAsync} from "../task-store/async-merge-coordination.js";
import type {MergeQueueRow} from "../task-store/row-types.js";

/**
 * Step state is written from more places than an agent's explicit
 * `fn_task_update` call: workflow projection, review auto-approval, restart
 * reconciliation, and self-healing all use the same store mutation. Keep the
 * baseline task-chat narration here so those legitimate transitions cannot be
 * invisible just because they took a different execution path.
 */
function proactiveStepStatusMessage(
  stepIndex: number,
  stepName: string,
  previousStatus: import("../types.js").StepStatus,
  status: import("../types.js").StepStatus,
): string | null {
  if (previousStatus === status) return null;
  const label = stepName.trim() || `Step ${stepIndex}`;
  switch (status) {
    case "in-progress":
      return `Starting Step ${stepIndex}: ${label}`;
    case "done":
      return `Step ${stepIndex} finished — ${label}.`;
    case "skipped":
      return `Step ${stepIndex} was skipped — ${label}.`;
    case "pending":
      return `Step ${stepIndex} was returned to pending — ${label}.`;
  }
}

async function appendProactiveStepStatus(store: TaskStore, taskId: string, message: string | null): Promise<void> {
  if (!message) return;
  if ((await store.getSettingsFast()).proactiveTaskChatEnabled !== true) return;
  // The task mutation is authoritative. Chat narration is an observational,
  // best-effort companion and must never make a lifecycle transition fail.
  await store.appendAgentLog(taskId, message, "status", undefined, "executor");
}

export async function updateStepImpl(store: TaskStore, id: string, stepIndex: number, status: import("../types.js").StepStatus, options?: { source?: "graph" },): Promise<Task> {
    // FNXC:WorkflowStepOrdering 2026-07-20-20:05:
    // Step-inversion projection discipline (U6/KTD-7). A `source: "graph"` write
    // is the workflow-graph executor projecting a foreach instance's lifecycle
    // (in-progress / done / pending) onto Task.steps[] with EXPLICIT indices. Three
    // behaviors diverge from a legacy write with no explicit dependency metadata:
    //   (a) the out-of-order start/completion guard uses DEPENDENCY order (an
    //       in-progress or done write is legal when every dependsOn step —
    //       default: the immediately-preceding step — is done/skipped, KTD-11).
    //       Explicit dependsOn metadata is
    //       authoritative for every writer, not only graph-tagged writes;
    //   (b) a guard that DOES suppress a graph write logs an audit warning loudly
    //       (legacy stays silent — a graph suppression is a projection bug);
    //   (c) the auto-reinit-from-PROMPT.md path is bypassed (the graph pinned the
    //       step count at foreach expansion; re-parsing here would desync, KTD-3).
    const graphSource = options?.source === "graph";
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);

      // Auto-initialize steps from PROMPT.md if empty. Bypassed for graph-source
      // writes (U6/KTD-3): the graph owns explicit indices pinned at expansion.
      // FNXC:TaskDetailPromptResilience 2026-07-10-15:00 (merge port from main):
      // step auto-init is best-effort — an unreadable PROMPT.md must not fail
      // updateStep; proceed with the persisted (empty) steps.
      let promptStepsUnavailable: string | undefined;
      if (task.steps.length === 0 && !graphSource) {
        try {
          task.steps = await store.parseStepsFromPrompt(id);
        } catch (err) {
          // Remember WHY steps couldn't be resolved so the range check below
          // attributes the failure to the unreadable PROMPT.md rather than a
          // misleading "0 steps".
          promptStepsUnavailable = err instanceof Error ? err.message : String(err);
          storeLog.warn(`[task-detail] failed to auto-init steps from PROMPT.md for ${id}: ${promptStepsUnavailable}`);
        }
      }

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (stepIndex < 0 || stepIndex >= task.steps.length) {
        // FNXC:TaskDetailPromptResilience 2026-07-10-16:30 (merge port from main):
        // when the range failure is caused by an unreadable PROMPT.md (not a
        // genuinely stepless task), surface the real cause.
        if (promptStepsUnavailable !== undefined && task.steps.length === 0) {
          throw new Error(
            `Cannot update step ${stepIndex} for ${id}: its steps are defined in PROMPT.md, which could not be read (${promptStepsUnavailable}).`,
          );
        }
        throw new Error(
          `Step ${stepIndex} out of range (task has ${task.steps.length} steps)`,
        );
      }

      // Guard against agents (or stale tool calls) regressing completed work
      // by re-marking a done/skipped step as "in-progress". Overwriting the
      // step status would silently undo progress, and the currentStep
      // rewind below would discard the task's place in the plan.
      const currentStatus = task.steps[stepIndex].status;
      if (
        status === "in-progress" &&
        (currentStatus === "done" || currentStatus === "skipped")
      ) {
        const ts = new Date().toISOString();
        task.updatedAt = ts;
        task.log.push({
          timestamp: ts,
          action: `Ignored ${currentStatus}→in-progress regression for step ${stepIndex} (${task.steps[stepIndex].name})`,
        });
        await store.atomicWriteTaskJson(dir, task);
        if (store.isWatching) store.taskCache.set(id, { ...task });
        store.emit("task:updated", task);
        return task;
      }

      if (status === "done" || status === "in-progress") {
        // The set of predecessor steps that must be done/skipped before this step
        // may start or finish. Explicit dependency metadata is authoritative
        // regardless of which execution surface performs the write: parallel
        // step sessions and graph foreach instances share the same Task.steps[]
        // contract. When metadata is absent, legacy callers retain strict index
        // order while a graph-source write defaults to the immediately preceding
        // step (KTD-11).
        const explicitDependencies = task.steps[stepIndex]?.dependsOn;
        const hasExplicitDependencies = Array.isArray(explicitDependencies);
        const validExplicitDependencies =
          hasExplicitDependencies &&
          explicitDependencies.every(
            (dependency) =>
              Number.isInteger(dependency) &&
              dependency >= 0 &&
              dependency < stepIndex,
          );
        const dependencyOrdered =
          validExplicitDependencies || (!hasExplicitDependencies && graphSource);

        if (hasExplicitDependencies && !validExplicitDependencies) {
          const ts = new Date().toISOString();
          task.log.push({
            timestamp: ts,
            action:
              `[integrity-warning] invalid dependsOn metadata for step ${stepIndex} ` +
              `(${task.steps[stepIndex].name}); using strict index-order completion guard`,
          });
        }
        let blockingIndex = -1;
        let blockingStatus: import("../types.js").StepStatus | undefined;
        if (dependencyOrdered) {
          const depIndices =
            validExplicitDependencies
              ? explicitDependencies!
              : stepIndex > 0
              ? [stepIndex - 1]
              : [];
          for (const i of depIndices) {
            const priorStatus = task.steps[i]?.status;
            if (priorStatus === "pending" || priorStatus === "in-progress") {
              blockingIndex = i;
              blockingStatus = priorStatus;
              break;
            }
          }
        } else {
          for (let i = 0; i < stepIndex; i++) {
            const priorStatus = task.steps[i].status;
            if (priorStatus === "pending" || priorStatus === "in-progress") {
              blockingIndex = i;
              blockingStatus = priorStatus;
              break;
            }
          }
        }
        if (blockingIndex !== -1) {
          const ts = new Date().toISOString();
          task.updatedAt = ts;
          const kind = dependencyOrdered ? "dependency-order" : "out-of-order";
          task.log.push({
            timestamp: ts,
            action:
              `Ignored ${kind} ${status} for step ${stepIndex} (${task.steps[stepIndex].name}) — ` +
              `${dependencyOrdered ? "dependency" : "earlier"} step ${blockingIndex} (${task.steps[blockingIndex].name}) is still ${blockingStatus}`,
          });
          // Graph-source suppression is a projection bug — surface it loudly in
          // the activity log (U6) rather than the legacy silent ignore.
          if (graphSource) {
            task.log.push({
              timestamp: ts,
              action:
                `[integrity-warning] graph-source updateStep suppressed: step ${stepIndex} ` +
                `(${task.steps[stepIndex].name}) → ${status} blocked by unmet dependency ` +
                `step ${blockingIndex} (${blockingStatus})`,
            });
          }
          await store.atomicWriteTaskJson(dir, task);
          if (store.isWatching) store.taskCache.set(id, { ...task });
          store.emit("task:updated", task);
          return task;
        }
      }

      task.steps[stepIndex].status = status;
      task.updatedAt = new Date().toISOString();

      // Recompute from the full list: an out-of-index parallel step may have
      // moved currentStep ahead of an earlier unfinished dependency branch.
      if (status === "done") {
        const firstUnfinished = task.steps.findIndex(
          (step) => step.status !== "done" && step.status !== "skipped",
        );
        task.currentStep = firstUnfinished === -1 ? task.steps.length : firstUnfinished;
      } else if (status === "in-progress") {
        task.currentStep = stepIndex;
      }

      /*
      FNXC:SelfHealing 2026-06-21-12:45:
      Forward progress clears the stuck-kill streak. stuckKillCount is otherwise a lifetime
      counter — incremented by self-healing on each stuck-kill (checkStuckBudget) and reset
      ONLY by a manual retry (manual-retry-reset) — so a long task that genuinely advances
      between intermittent stalls could still be terminalized by accumulation toward
      maxStuckKills (default 6). Resetting when a step reaches a terminal forward status
      (done/skipped) makes only CONSECUTIVE stalls count toward the budget. This does NOT
      rescue a task wedged re-running the same failing step (no step completes between those
      kills, so the streak keeps climbing and the task still terminalizes as designed); it
      bounds the budget to consecutive no-progress stalls. Complements the FN-5048
      verification-fan-out cap that keeps verification from being slow in the first place.
      */
      if ((status === "done" || status === "skipped") && (task.stuckKillCount ?? 0) > 0) {
        task.stuckKillCount = undefined;
        task.log.push({
          timestamp: task.updatedAt,
          action: `Reset stuck-kill streak (forward progress: step ${stepIndex} (${task.steps[stepIndex].name}) → ${status})`,
        });
      }

      // Log it
      task.log.push({
        timestamp: task.updatedAt,
        action: `Step ${stepIndex} (${task.steps[stepIndex].name}) → ${status}`,
      });

      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });

      store.emit("task:updated", task);
      await appendProactiveStepStatus(
        store,
        id,
        proactiveStepStatusMessage(stepIndex, task.steps[stepIndex].name, currentStatus, status),
      ).catch(() => undefined);
      return task;
    });
  }

export async function acquireMergeQueueLeaseImpl(store: TaskStore, workerId: string, opts: MergeQueueAcquireOptions): Promise<MergeQueueEntry | null> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return acquireMergeQueueLeaseAsync(layer, workerId, opts);
    }
    if (opts.leaseDurationMs <= 0) {
      throw new InvalidMergeQueueLeaseDurationError(opts.leaseDurationMs);
    }

    return store.db.transactionImmediate(() => {
      const now = opts.now ?? new Date().toISOString();
      const leaseExpiresAt = new Date(Date.parse(now) + opts.leaseDurationMs).toISOString();
      store.cleanupStaleMergeQueueRows(now);

      let leased: MergeQueueRow | undefined;
      if (opts.targetTaskId) {
        leased = store.db.prepare(`
          UPDATE mergeQueue
             SET leasedBy = ?, leasedAt = ?, leaseExpiresAt = ?
           WHERE taskId = ?
             AND EXISTS (
               SELECT 1
                 FROM tasks t
                WHERE t.id = mergeQueue.taskId
                  AND t.column = 'in-review'
             )
             AND (leasedBy IS NULL OR leaseExpiresAt <= ?)
           RETURNING *
        `).get(workerId, now, leaseExpiresAt, opts.targetTaskId, now) as MergeQueueRow | undefined;

        if (!leased) {
          const queueHead = store.db.prepare(`
            SELECT mq.taskId, mq.leasedBy, t.column
              FROM mergeQueue mq
              LEFT JOIN tasks t ON t.id = mq.taskId
             ORDER BY CASE mq.priority
                        WHEN 'urgent' THEN 0
                        WHEN 'high'   THEN 1
                        WHEN 'normal' THEN 2
                        WHEN 'low'    THEN 3
                        ELSE 4
                      END ASC,
                      mq.enqueuedAt ASC
             LIMIT 1
          `).get() as { taskId: string; leasedBy: string | null; column: string | null } | undefined;

          store.insertRunAuditEventRow({
            taskId: opts.targetTaskId,
            domain: "database",
            mutationType: "mergeQueue:lease-target-unavailable",
            target: opts.targetTaskId,
            metadata: {
              targetTaskId: opts.targetTaskId,
              workerId,
              queueHeadTaskId: queueHead?.taskId ?? null,
              queueHeadLeasedBy: queueHead?.leasedBy ?? null,
              queueHeadColumn: queueHead?.column ?? null,
            },
          });
          return null;
        }
      } else {
        leased = store.db.prepare(`
          UPDATE mergeQueue
             SET leasedBy = ?, leasedAt = ?, leaseExpiresAt = ?
           WHERE taskId = (
             SELECT mq.taskId
               FROM mergeQueue mq
               JOIN tasks t ON t.id = mq.taskId
              WHERE t.column = 'in-review'
                AND (mq.leasedBy IS NULL OR mq.leaseExpiresAt <= ?)
              ORDER BY CASE mq.priority
                         WHEN 'urgent' THEN 0
                         WHEN 'high'   THEN 1
                         WHEN 'normal' THEN 2
                         WHEN 'low'    THEN 3
                         ELSE 4
                       END ASC,
                       mq.enqueuedAt ASC
              LIMIT 1
           )
           RETURNING *
        `).get(workerId, now, leaseExpiresAt, now) as MergeQueueRow | undefined;

        if (!leased) {
          return null;
        }
      }

      const entry = store.rowToMergeQueueEntry(leased);
      store.insertRunAuditEventRow({
        taskId: entry.taskId,
        domain: "database",
        mutationType: "mergeQueue:lease-acquired",
        target: entry.taskId,
        metadata: {
          taskId: entry.taskId,
          workerId,
          leaseExpiresAt: entry.leaseExpiresAt,
          priority: entry.priority,
        },
      });
      return entry;
    });
  }

export async function mergeTaskImpl(store: TaskStore, id: string): Promise<MergeResult> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      // FNXC:Workspace 2026-06-21-19:05:
      // R7 merge-boundary guard (master-plan U0). Reject workspace-mode tasks
      // BEFORE any git checkout/squash — they need the per-repo merge loop that
      // lands in master-plan U6, which removes this guard. See the predicate's
      // FNXC:Workspace note in @fusion/core types.
      assertNotWorkspaceTaskMerge(task);
      const branch = task.branch || `fusion/${id.toLowerCase()}`;
      // Branch is derived from the task id (already validated at create time),
      // but assert as defense-in-depth against future id-format changes.
      assertSafeGitBranchName(branch);

      if (task.column === "done") {
        const result: MergeResult = {
          task,
          branch,
          merged: false,
          worktreeRemoved: false,
          branchDeleted: false,
        };

        const worktreePath = task.worktree;
        const changed = store.clearDoneTransientFields(task);

        if (worktreePath && existsSync(worktreePath)) {
          assertSafeAbsolutePath(worktreePath);
          const removeWorktree = await store.runGitCommand(`git worktree remove "${worktreePath}" --force`, 120_000);
          if (removeWorktree.exitCode === 0) {
            result.worktreeRemoved = true;
          }
        }

        const deleteBranch = await store.runGitCommand(`git branch -d "${branch}"`);
        if (deleteBranch.exitCode === 0) {
          result.branchDeleted = true;
        } else {
          const forceDeleteBranch = await store.runGitCommand(`git branch -D "${branch}"`);
          if (forceDeleteBranch.exitCode === 0) {
            result.branchDeleted = true;
          }
        }

        if (changed) {
          task.updatedAt = new Date().toISOString();
          await store.atomicWriteTaskJson(dir, task);
          if (store.isWatching) store.taskCache.set(id, { ...task });
          store.emit("task:updated", task);
        }

        result.task = task;
        return result;
      }

      const mergeBlocker = getTaskMergeBlocker(task);
      if (mergeBlocker) {
        throw new Error(`Cannot merge ${id}: ${mergeBlocker}`);
      }

      const worktreePath = task.worktree;
      const result: MergeResult = {
        task,
        branch,
        merged: false,
        worktreeRemoved: false,
        branchDeleted: false,
      };

      const settings = await store.getSettings();
      const normalizedIntegrationBranch =
        typeof settings.integrationBranch === "string" ? settings.integrationBranch.trim() : "";
      const normalizedBaseBranch = typeof settings.baseBranch === "string" ? settings.baseBranch.trim() : "";
      let projectDefaultBranch =
        normalizedIntegrationBranch.length > 0
          ? normalizedIntegrationBranch
          : normalizedBaseBranch.length > 0
            ? normalizedBaseBranch
            : "";
      if (!projectDefaultBranch) {
        const originHead = await store.runGitCommand("git symbolic-ref --short refs/remotes/origin/HEAD", 5_000);
        if (originHead.exitCode === 0) {
          projectDefaultBranch = originHead.stdout
            .trim()
            .replace(/^refs\/heads\//, "")
            .replace(/^refs\/remotes\/origin\//, "")
            .replace(/^origin\//, "");
        }
      }
      const mergeTarget = resolveTaskMergeTarget(task, {
        projectDefaultBranch: projectDefaultBranch || undefined,
      });

      // 1. Check the branch exists
      const verifyBranch = await store.runGitCommand(`git rev-parse --verify "${branch}"`);
      if (verifyBranch.exitCode !== 0) {
        // No branch — might have been manually merged. Just move to done.
        result.error = `Branch '${branch}' not found — moving to done without merge`;
        task.mergeDetails = {
          mergedAt: new Date().toISOString(),
          mergeConfirmed: false,
          prNumber: task.prInfo?.number,
          mergeTargetBranch: mergeTarget.branch,
          mergeTargetSource: mergeTarget.source,
        };
        await store.moveToDone(task, dir);
        result.task = { ...task, column: "done" };
        store.emit("task:merged", result);
        return result;
      }

      const checkoutTarget = await store.runGitCommand(`git checkout "${mergeTarget.branch}"`, 120_000);
      if (checkoutTarget.exitCode !== 0) {
        throw new Error(`Unable to checkout merge target branch '${mergeTarget.branch}' for ${id}`);
      }

      // 2. Merge the branch
      const mergeCommitMessage = `feat(${id}): merge ${branch}`;
      const merge = await store.runGitCommand(`git merge --squash "${branch}"`, 120_000);
      const commit = merge.exitCode === 0
        ? await store.runGitCommand(`git commit --no-edit -m "${mergeCommitMessage}"`, 120_000)
        : merge;

      if (merge.exitCode === 0 && commit.exitCode === 0) {
        result.merged = true;
        const mergeDetails = await store.collectMergeDetails(id, branch, task, mergeCommitMessage, mergeTarget);
        task.mergeDetails = mergeDetails;
        if (mergeDetails.landedFiles && mergeDetails.landedFiles.length > 0) {
          task.modifiedFiles = mergeDetails.landedFiles;
        }
        Object.assign(result, mergeDetails);
      } else {
        // Squash conflict — reset and report
        await store.runGitCommand("git reset --merge");
        throw new Error(
          `Merge conflict merging '${branch}'. Resolve manually:\n` +
            `  cd ${store.rootDir}\n` +
            `  git merge --squash ${branch}\n` +
            `  # resolve conflicts, then: fn task move ${id} done`,
        );
      }

      // 3. Remove worktree
      if (worktreePath && existsSync(worktreePath)) {
        assertSafeAbsolutePath(worktreePath);
        const removeWorktree = await store.runGitCommand(`git worktree remove "${worktreePath}" --force`, 120_000);
        if (removeWorktree.exitCode === 0) {
          result.worktreeRemoved = true;
        }
      }

      // 4. Delete the branch
      const deleteBranch = await store.runGitCommand(`git branch -d "${branch}"`);
      if (deleteBranch.exitCode === 0) {
        result.branchDeleted = true;
      } else {
        // Branch might not be fully merged in some edge cases; try force
        const forceDeleteBranch = await store.runGitCommand(`git branch -D "${branch}"`);
        if (forceDeleteBranch.exitCode === 0) {
          result.branchDeleted = true;
        }
      }

      // 5. Move task to done
      await store.moveToDone(task, dir);
      result.task = { ...task, column: "done" };

      store.emit("task:merged", result);
      return result;
    });
  }
