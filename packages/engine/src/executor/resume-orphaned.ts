/**
 * FNXC:CodeOrganization 2026-08-03-10:35:
 * resumeOrphaned peeled from TaskExecutor (U4).
 * Startup recovery for orphaned WIP tasks after crash/restart.
 *
 * FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (a MISSED PAIR, the class #2879 ratcheted):
 * `listWipLaneTasks()` already resolves the wip lane by role. This filter must not re-assert
 * the literal `in-progress` on the rows that read returned, or on a renamed board the read
 * finds orphans and the filter drops every one — recovery silently does nothing after restart.
 */
import type { Task, TaskStore } from "@fusion/core";
import { resolveProjectColumnsForRoles } from "@fusion/core";
import { setImmediate as setImmediateCb } from "node:timers";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { executorLog } from "../logger.js";
import { getResumeOrphanDelayMs } from "./resume-orphan-delay.js";
import { isNoProgressNoTaskDoneFailure, isTaskWorkComplete } from "./task-predicates.js";

const yieldEventLoop = (): Promise<void> => new Promise((resolve) => setImmediateCb(resolve));

// FNXC:MergeRetryReliability 2026-08-29-18:10 (CodeRabbit 17:59): an intent
// older than this horizon is stale — the failure it describes predates an
// operator requeue (task left the WIP lane and returned). Ignore and remove
// it instead of parking the task with a dead run's message.
const DEFERRED_PARK_INTENT_MAX_AGE_MS = 60 * 60 * 1000;

export type ResumeOrphanedDeps = {
  store: TaskStore;
  rootDir?: string;
  executing: Set<string>;
  recoveringCompleted: Set<string>;
  processWideGraphRouting: Set<string>;
  listWipLaneTasks: () => Promise<Task[]>;
  clearResumeFailureState: (task: Task) => Promise<void>;
  recoverApprovedStepsOnResume: (taskId: string) => Promise<void>;
  recoverCompletedTask: (task: Task) => Promise<boolean>;
  execute: (task: Task) => Promise<void>;
};

export async function resumeOrphaned(deps: ResumeOrphanedDeps): Promise<void> {
  const settings = await deps.store.getSettings();
  if (settings.globalPause || settings.enginePaused) {
    executorLog.log(
      `resumeOrphaned skipped — ${
        settings.globalPause ? "global pause" : "engine pause"
      } is active`,
    );
    return;
  }

  const wipColumns = await resolveProjectColumnsForRoles(deps.store, ["countsTowardWip"]);
  const tasks = await deps.listWipLaneTasks();
  const inProgress = tasks.filter(
    (t) => wipColumns.has(t.column) && !t.deletedAt && !deps.executing.has(t.id) && !t.paused,
  );

  if (inProgress.length === 0) return;

  executorLog.log(`Found ${inProgress.length} orphaned in-progress task(s)`);
  const resumeDelayMs = getResumeOrphanDelayMs();
  if (resumeDelayMs > 0) {
    executorLog.log(
      `Deferring orphan task resumption for ${resumeDelayMs}ms to keep dashboard responsive during cold start`,
    );
  }
  // When the delay is zero (default in tests and when explicitly disabled),
  // skip the setTimeout indirection so the spawn happens on the current
  // microtask — matching the legacy behavior callers may rely on.
  const scheduleResume = resumeDelayMs > 0
    ? (fn: () => void) => { setTimeout(fn, resumeDelayMs); }
    : (fn: () => void) => { fn(); };
  let yieldNext = false;
  for (const task of inProgress) {
    if (yieldNext) await yieldEventLoop();
    yieldNext = true;
    /*
    FNXC:MergeRetryReliability 2026-08-29-14:35 (Greptile round-9 Issue 1): a
    deferred terminal-park intent persisted by handleGraphFailure's deferred
    chain means this task's failure was never durably written (store outage at
    the time) — the engine died before the retry chain landed. PARK it now
    with the original message instead of re-executing the failed run; only a
    row that is no longer parkable (already terminal / deleted / paused)
    clears the intent without a write.
    */
    // FNXC:MergeRetryReliability 2026-08-29-16:52 (CodeRabbit L1331): the
    // reader must resolve the SAME task directory the writer used — including
    // the rootDir/.fusion/tasks fallback when the store has no getTasksDir.
    const tasksDir = typeof deps.store.getTasksDir === "function"
      ? deps.store.getTasksDir()
      : deps.rootDir ? join(deps.rootDir, ".fusion", "tasks") : undefined;
    const intentPath = tasksDir ? join(tasksDir, task.id, "deferred-terminal-park.json") : undefined;
    if (intentPath) {
      let raw: string | undefined;
      try {
        raw = await readFile(intentPath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          /*
          FNXC:MergeRetryReliability 2026-09-04-01:51:
          A failed read says nothing about the intent's contents. Retain it and
          skip this pass so transient filesystem failures neither fabricate a
          corruption park nor re-execute work whose terminal state is unknown.
          */
          executorLog.warn(`${task.id}: deferred terminal-park intent could not be read (${error instanceof Error ? error.message : String(error)}) — retaining intent and skipping orphan recovery`);
          continue;
        }
        raw = undefined;
      }
      let deferredMessage: string | undefined;
      let parsedColumnMovedAt: string | undefined;
      if (raw !== undefined) {
        try {
          const parsed = JSON.parse(raw) as { message?: unknown; writtenAt?: unknown; columnMovedAt?: unknown };
          parsedColumnMovedAt = typeof parsed.columnMovedAt === "string" ? parsed.columnMovedAt : undefined;
          /*
          FNXC:MergeRetryReliability 2026-09-04-01:51:
          columnMovedAt identifies the execution that created an intent because
          every move and requeue stamps it, unlike noisy updatedAt writes. A
          matching legacy-missing value falls back to the age backstop.
          */
          const superseded = typeof parsed.columnMovedAt === "string"
            && typeof task.columnMovedAt === "string"
            && parsed.columnMovedAt !== task.columnMovedAt;
          // FNXC:MergeRetryReliability 2026-08-29-18:10 (CodeRabbit 17:59): bound
          // legacy intent recovery to a freshness horizon when no durable move
          // identity is available.
          const writtenAtMs = typeof parsed.writtenAt === "string" ? Date.parse(parsed.writtenAt) : Number.NaN;
          const stale = !superseded && Number.isFinite(writtenAtMs) && Date.now() - writtenAtMs > DEFERRED_PARK_INTENT_MAX_AGE_MS;
          if (superseded) {
            await rm(intentPath, { force: true }).catch(() => undefined);
            executorLog.log(`${task.id}: deferred terminal-park intent was superseded by a lane move — cleared, normal orphan recovery`);
          } else if (stale) {
            await rm(intentPath, { force: true }).catch(() => undefined);
            executorLog.log(`${task.id}: deferred terminal-park intent is stale (> ${DEFERRED_PARK_INTENT_MAX_AGE_MS}ms old) — cleared, normal orphan recovery`);
          } else if (typeof parsed.message === "string") {
            deferredMessage = parsed.message;
          } else {
            deferredMessage = "deferred-terminal-park intent was corrupted by a crash mid-write — parked instead of re-executing";
          }
        } catch {
          deferredMessage = "deferred-terminal-park intent was corrupted by a crash mid-write — parked instead of re-executing";
        }
      }
      if (deferredMessage) {
        let intentParked = false;
        let intentSupersededAtApply = false;
        try {
          await deps.store.updateTaskAtomic(task.id, (current) => {
            // FNXC:MergeRetryReliability 2026-08-29-17:45 (CodeRabbit L100): a
            // lane-resident row may carry status undefined (never set back to
            // null during requeue); === null would treat it as terminal and
            // delete the intent without parking. Nullish comparison parks it.
            // FNXC:MergeRetryReliability 2026-09-04-01:51: validate the lane
            // identity in the atomic reducer as well as the startup snapshot;
            // an operator can requeue after the file read but before this write.
            if (!current || current.deletedAt || current.status != null || current.paused || current.userPaused) return null;
            if (
              typeof parsedColumnMovedAt === "string"
              && typeof current.columnMovedAt === "string"
              && current.columnMovedAt !== parsedColumnMovedAt
            ) {
              intentSupersededAtApply = true;
              return null;
            }
            intentParked = true;
            return { error: deferredMessage, status: "failed" };
          });
        } catch (error) {
          executorLog.error(`${task.id}: deferred terminal-park intent could not be applied at restart (${error instanceof Error ? error.message : String(error)}) — keeping intent, not re-executing`);
          continue;
        }
        await rm(intentPath, { force: true }).catch(() => undefined);
        if (intentParked) {
          executorLog.warn(`${task.id}: applied deferred terminal-park intent after restart — task parked failed with the original graph-failure message`);
          continue;
        }
        if (intentSupersededAtApply) {
          executorLog.log(`${task.id}: deferred terminal-park intent was superseded by a lane move during restart recovery — cleared, normal orphan recovery`);
        } else {
          executorLog.log(`${task.id}: deferred terminal-park intent cleared without write (row already terminal/deleted/paused)`);
          continue;
        }
      }
    }
    // Fast-path: if the task already completed its work (all steps done),
    // move it directly to in-review instead of re-executing from scratch.
    if (isTaskWorkComplete(task) && !task.mergeDetails) {
      if (deps.recoveringCompleted.has(task.id)) {
        executorLog.debug(`${task.id} completed-task recovery already running - skipping duplicate startup recovery`);
        continue;
      }
      if (deps.processWideGraphRouting.has(task.id)) {
        executorLog.debug(`${task.id} owned by the workflow graph interpreter — skipping completed-task fast-path`);
        continue;
      }
      executorLog.log(`${task.id} is already complete — fast-pathing to in-review`);
      deps.recoveringCompleted.add(task.id);
      scheduleResume(() => {
        void deps.recoverCompletedTask(task)
          .catch((err) =>
            executorLog.error(`Failed to recover completed orphan ${task.id}:`, err),
          )
          .finally(() => {
            deps.recoveringCompleted.delete(task.id);
          });
      });
      continue;
    }

    if (isNoProgressNoTaskDoneFailure(task)) {
      executorLog.log(`${task.id} failed without fn_task_done and has no step progress — leaving for self-healing requeue`);
      continue;
    }

    executorLog.log(`Resuming ${task.id}: ${task.title || task.description.slice(0, 60)}`);
    try {
      await deps.clearResumeFailureState(task);
      await deps.store.logEntry(task.id, "Resumed after engine restart");
      await deps.recoverApprovedStepsOnResume(task.id);
    } catch (err) {
      executorLog.error(`Failed to write resume log for ${task.id}:`, err);
    }
    scheduleResume(() => {
      deps.execute(task).catch((err) =>
        executorLog.error(`Failed to resume ${task.id}:`, err),
      );
    });
  }
}
