/**
 * FNXC:CodeOrganization 2026-08-10-04:05:
 * Workspace reconcilers peeled from SelfHealingManager (U5 / wave19 Slice B).
 *
 * FNXC:Workspace 2026-06-22-09:30 / 2026-06-22-14:10:
 * Partial-land re-enqueue, phantom land-lease reclaim, pre-execution worktree release,
 * and orphaned per-repo worktree cleanup. Bounded, no temp-root walks.
 *
 * FNXC:CodeOrganization 2026-08-15-22:49:
 * Main landed durable liveness, land-intent-adjacent evidence, FORK-A evidence-unavailable
 * parking, persistWorkspaceRepoLandFailure breadcrumbs, and FN-9056 teardown phase markers
 * after this peel. Those production invariants stay here next to their siblings; the class
 * only wires the host and keeps the test-overridable git/liveness seams.
 *
 * FNXC:CodeOrganization 2026-08-23-22:38:
 * Later main commits added merge-blocker / confirmed-scope recovery, recorded base-branch
 * resolution, task-owned mergeTransientRetryCount, and isFusionDeletableBranch teardown.
 * Keep those invariants in this module rather than re-inlining the reconcilers.
 *
 * FNXC:CodeOrganization 2026-09-04-04:43:
 * FN-268's unified-layout task-directory teardown landed on main after this peel. Keep that
 * empty-directory removal next to per-repo settlement so the class wrapper cannot drift.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import {
  REVIEW_ROLES,
  allowsAutoMergeProcessing,
  columnsWithFlag,
  getTaskMergeBlocker,
  isFusionDeletableBranch,
  isLegacyWorkspaceWorktreeLayout,
  isWorkspaceTask,
  resolveProjectColumnsForRoles,
  resolveWorkflowIrForTaskWithProvenance,
  resolveWorkspaceTaskWorktreeDir,
} from "@fusion/core";
import { createLogger } from "../logger.js";
import { ACTIVE_MERGE_STATUSES } from "../merge/merge-active-status.js";
import { isRepoLanded } from "../merge/workspace-land-predicate.js";
import { removeEmptyWorkspaceTaskDirectory } from "../merge/post-landing-worktree-cleanup.js";
import { persistWorkspaceRepoLandFailure } from "../merge/workspace-land-failure.js";
import { STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS } from "../healing/self-healing-constants.js";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { createRunAuditor, generateSyntheticRunId, type RunAuditor } from "../util/run-audit.js";
import { shellQuote } from "../self-healing-git-evidence.js";
import { resolveTaskWorkingBranch } from "../worktree/worktree-names.js";
import { recordWorkspaceBaseBranchDecision, resolveWorkspaceRepoBaseBranch } from "../worktree/workspace-base-branch.js";
import { isWorkspaceOwnerLive, isWorkspaceTaskLive, workspaceOwnerTerminalReason } from "./workspace-liveness.js";
import {
  MAX_STARVATION_DROPS,
  PHANTOM_EXECUTOR_BINDING_AGE_MULTIPLIER,
  PRE_EXECUTION_WORKTREE_MAX_IDLE_MS,
  TERMINAL_WORKSPACE_WORKTREE_TEARDOWN_MIN_IDLE_MS,
} from "./sweep-constants.js";

const log = createLogger("self-healing");

export type WorkspaceReconcileHost = {
  store: TaskStore;
  options: {
    rootDir: string;
    getActiveMergeTaskId?: () => string | null;
    isMergePending?: (taskId: string) => boolean | Promise<boolean>;
    isTaskActive?: (taskId: string) => boolean;
    enqueueMerge?: (taskId: string) => boolean;
    releasePreExecutionWorktree?: (taskId: string, reason: string) => Promise<boolean>;
  };
  workspacePartialLandDrops: Map<string, number>;
  workspacePartialLandEvidenceDefers: Map<string, number>;
  orphanWorktreeRemovalFailures: Map<string, number>;
  settledWorkspaceWorktreeTeardowns: Set<string>;
  prunedWorkspaceWorktreeTeardowns: Set<string>;
  probeRepoBranch: (repoRootDir: string, branch: string) => Promise<"present" | "absent" | "unknown">;
  execWorkspaceTeardownGit: (command: string, options: { cwd: string; timeout: number }) => Promise<{ stdout: string }>;
  isWorkspaceTaskLiveDurably: (task: Task) => Promise<{ live: boolean; livePaths: string[] }>;
  isLegacyCompleteColumnForWorkspaceTeardown: (column: string) => boolean;
};

async function emitWorkspacePartialLandNoAction(
  host: WorkspaceReconcileHost,
  task: Task,
  reason: "auto-merge-off" | "user-paused" | "live-worktree" | "merge-pending" | "merge-blocked" | "evidence-unavailable" | "scope-unresolved" | "empty-obligations",
  livePaths: string[],
): Promise<void> {
  try {
    await createRunAuditor(host.store, {
      runId: generateSyntheticRunId("self-healing-workspace-partial-land-no-action", task.id),
      agentId: "self-healing",
      taskId: task.id,
      taskLineageId: task.lineageId,
      phase: "reconcile-workspace-partial-land",
    }).database({
      type: "task:reconcile-workspace-partial-land-no-action",
      target: task.id,
      metadata: { taskId: task.id, reason, livePaths },
    });
  } catch (err: unknown) {
    log.warn(`reconcileWorkspacePartialLands: audit emit failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function enqueueWorkspaceMergeBounded(
  host: WorkspaceReconcileHost,
  task: Task,
  auditor: RunAuditor,
  input: { landedRepos: string[]; unlandedRepos: string[]; reason: string; successLog: string },
): Promise<boolean> {
  const enqueueMerge = host.options.enqueueMerge;
  if (!enqueueMerge) {
    host.workspacePartialLandDrops.delete(task.id);
    await host.store.logEntry(task.id, `${input.successLog} (enqueue not wired — deferred to next sweep)`);
    await auditor.database({
      type: "task:reconcile-workspace-partial-land",
      target: task.id,
      metadata: { taskId: task.id, landedRepos: input.landedRepos, unlandedRepos: input.unlandedRepos, failedRepos: [], action: "re-enqueue-noop", reason: input.reason },
    }).catch(() => undefined);
    return false;
  }

  const queued = enqueueMerge(task.id);
  if (queued) {
    host.workspacePartialLandDrops.delete(task.id);
    await host.store.logEntry(task.id, input.successLog);
    await auditor.database({
      type: "task:reconcile-workspace-partial-land",
      target: task.id,
      metadata: { taskId: task.id, landedRepos: input.landedRepos, unlandedRepos: input.unlandedRepos, failedRepos: [], action: "re-enqueue", reason: input.reason },
    }).catch(() => undefined);
    return false;
  }

  /*
  FNXC:WorkspaceFinalization 2026-08-21-08:46:
  Queue rejection is a recovery failure, not a successful recovery. Persist its counter before
  returning so a new SelfHealingManager cannot reset an infinite five-minute scheduling loop.
  `mergeTransientRetryCount` is the established task-owned ceiling for transient merge attempts.
  */
  const drops = (task.mergeTransientRetryCount ?? 0) + 1;
  await host.store.updateTask(task.id, { mergeTransientRetryCount: drops });
  host.workspacePartialLandDrops.set(task.id, drops);
  log.warn(`reconcileWorkspacePartialLands: enqueue dropped for ${task.id} (${drops}/${MAX_STARVATION_DROPS}); merge queue rejected re-enqueue`);
  if (drops >= MAX_STARVATION_DROPS) {
    const error = `Workspace partial-land starvation: ${MAX_STARVATION_DROPS} consecutive enqueue attempts were dropped by the merge queue; task requires manual intervention.`;
    await host.store.updateTask(task.id, { status: "failed", error });
    await host.store.logEntry(task.id, error);
    host.workspacePartialLandDrops.delete(task.id);
    await auditor.database({
      type: "task:reconcile-workspace-partial-land",
      target: task.id,
      metadata: { taskId: task.id, landedRepos: input.landedRepos, unlandedRepos: input.unlandedRepos, failedRepos: [], action: "park-failed", reason: "enqueue-starvation" },
    }).catch(() => undefined);
    return true;
  }
  await auditor.database({
    type: "task:reconcile-workspace-partial-land",
    target: task.id,
    metadata: { taskId: task.id, landedRepos: input.landedRepos, unlandedRepos: input.unlandedRepos, failedRepos: [], action: "re-enqueue-dropped", reason: input.reason, drops },
  }).catch(() => undefined);
  return false;
}

export async function reconcileWorkspacePartialLands(host: WorkspaceReconcileHost): Promise<number> {
  try {
    const settings = await host.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return 0;

    const activeMergeTaskId = host.options.getActiveMergeTaskId?.() ?? null;
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-21:40:
    Workspace tasks live in the review lane while per-repo lands are incomplete.
    */
    const wsPartialColumns = await resolveProjectColumnsForRoles(host.store, REVIEW_ROLES);
    const wsPartialById = new Map<string, Task>();
    for (const column of wsPartialColumns) {
      for (const entry of await host.store.listTasks({ column, slim: true })) wsPartialById.set(entry.id, entry);
    }
    const tasks = [...wsPartialById.values()];
    const wsPartialLanes = new Map<string, Set<string>>();
    for (const entry of tasks) {
      try {
        const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(host.store, entry.id);
        wsPartialLanes.set(
          entry.id,
          source === "default"
            ? new Set(wsPartialColumns)
            : new Set(REVIEW_ROLES.flatMap((role) => [...columnsWithFlag(ir, role)])),
        );
      } catch {
        wsPartialLanes.set(entry.id, new Set(wsPartialColumns));
      }
    }
    const candidates = tasks.filter((task) =>
      (wsPartialLanes.get(task.id) ?? wsPartialColumns).has(task.column) &&
      isWorkspaceTask(task) &&
      task.mergeDetails?.mergeConfirmed !== true &&
      !(task.status && ACTIVE_MERGE_STATUSES.has(task.status)),
    );
    const candidateIds = new Set(candidates.map((t) => t.id));
    for (const taskId of [...host.workspacePartialLandDrops.keys()]) {
      if (!candidateIds.has(taskId)) host.workspacePartialLandDrops.delete(taskId);
    }
    for (const taskId of [...host.workspacePartialLandEvidenceDefers.keys()]) {
      if (!candidateIds.has(taskId)) host.workspacePartialLandEvidenceDefers.delete(taskId);
    }

    if (candidates.length === 0) return 0;

    let recovered = 0;
    for (const task of candidates) {
      try {
        if (!allowsAutoMergeProcessing(task, settings)) {
          await emitWorkspacePartialLandNoAction(host, task, "auto-merge-off", []);
          continue;
        }
        if (task.userPaused || task.paused) {
          await emitWorkspacePartialLandNoAction(host, task, "user-paused", []);
          continue;
        }
        const liveness = await host.isWorkspaceTaskLiveDurably(task);
        if (liveness.live) {
          await emitWorkspacePartialLandNoAction(host, task, "live-worktree", liveness.livePaths);
          continue;
        }
        if (activeMergeTaskId && activeMergeTaskId === task.id) {
          await emitWorkspacePartialLandNoAction(host, task, "live-worktree", liveness.livePaths);
          continue;
        }
        /*
        FNXC:Workspace 2026-06-22-16:40:
        GUARD 5 — task is anywhere in the in-memory merge pipeline.
        */
        if (await host.options.isMergePending?.(task.id) === true) {
          await emitWorkspacePartialLandNoAction(host, task, "merge-pending", liveness.livePaths);
          continue;
        }
        /*
        FNXC:WorkspaceFinalization 2026-08-21-08:46:
        Recovery is another merge door, not an exemption from graph-owned pre-merge review.
        Re-read immediately before scheduling so a failed/pending review cannot race a stale sweep
        into a lease or Git attempt; a retry never implicitly approves a negative verdict.
        */
        const latestTask = await host.store.getTask(task.id).catch(() => null);
        /*
        FNXC:WorkspaceFinalization 2026-08-21-08:52:
        A prior retryable workspace land failure is recovery input rather than a merge-content
        blocker. Strip only that known transient status for blocker evaluation; failed review
        results and every other failed/operator state remain merge-blocking and cannot enqueue.
        */
        const blockerTask = latestTask?.status === "failed" && latestTask.error?.startsWith("Workspace partial land:")
          ? { ...latestTask, status: null, error: undefined }
          : latestTask;
        /*
        FNXC:CodeOrganization 2026-08-23-22:38:
        Same skipColumnIdentityCheck call as main's inlined reconciler. Lane identity is already
        proven by the review-lane candidate filter; the lane-wiring allowance moves with this peel.
        */
        if (!blockerTask || getTaskMergeBlocker(blockerTask as Task, { skipColumnIdentityCheck: true }) !== undefined) {
          await emitWorkspacePartialLandNoAction(host, task, "merge-blocked", []);
          continue;
        }

        const workspaceWorktrees = task.workspaceWorktrees ?? {};
        /*
        FNXC:RepositoryScope 2026-08-20-23:57:
        Recovery must fail closed for an unconfirmed legacy scope. Acquired worktrees prove only
        checkout policy, never repository intent, so re-enqueueing them would restart FN-094's
        clean-peer land loop instead of waiting for an operator-confirmed scope.
        */
        const explicitScope = task.repositoryScope?.state === "confirmed" ? task.repositoryScope.repositories : undefined;
        if (!explicitScope) {
          await emitWorkspacePartialLandNoAction(host, task, "scope-unresolved", []);
          continue;
        }
        const repoKeys = Object.keys(workspaceWorktrees).filter((repoRel) =>
          explicitScope.includes(repoRel)
          && ((task.modifiedFiles ?? []).some((file) => file.startsWith(`${repoRel}/`)) || Boolean(workspaceWorktrees[repoRel]?.landedSha)),
        );
        if (repoKeys.length === 0) {
          await emitWorkspacePartialLandNoAction(host, task, "empty-obligations", []);
          continue;
        }
        const landedRepos: string[] = [];
        const unlandedRepos: string[] = [];
        const unrecoverableRepos: string[] = [];
        const evidenceUnavailableRepos: string[] = [];
        for (const repoRel of repoKeys) {
          const entry = workspaceWorktrees[repoRel];
          const repoRootDir = join(host.options.rootDir, repoRel);
          let integrationBranch: string;
          try {
            const baseResolution = await resolveWorkspaceRepoBaseBranch({
              mode: "recorded",
              repoRootDir,
              repoRelPath: repoRel,
              task,
              settings,
              recordedBaseBranch: entry.baseBranch,
            });
            integrationBranch = baseResolution.branch;
            await recordWorkspaceBaseBranchDecision({
              store: host.store,
              audit: createRunAuditor(host.store, {
                runId: generateSyntheticRunId("workspace-repo-base-branch", task.id),
                agentId: "system:self-healing",
                phase: "workspace-repo-base-branch",
              }),
              task,
              repoRelPath: repoRel,
              repoAbsPath: repoRootDir,
              resolution: baseResolution,
              stage: "self-heal",
            });
          } catch {
            unlandedRepos.push(repoRel);
            continue;
          }
          /*
          FNXC:Workspace 2026-08-15-06:45:
          A boundary-invalidated repo is unlanded here and therefore follows the existing
          branch-present retry path; FORK-A remains fail-closed when its branch is absent.
          */
          /* FNXC:Workspace 2026-08-15-07:05: Creation time bounds branch-gone trailer recovery against recycled task ids. */
          if (await isRepoLanded(repoRootDir, integrationBranch, entry.landedSha, task.id, entry.branch, entry.revertBoundarySha, task.createdAt)) {
            landedRepos.push(repoRel);
            continue;
          }
          /*
          FNXC:Workspace 2026-08-15-04:42:
          FORK-A may park only on proof, never absence of evidence. `probeRepoBranch` uses
          `show-ref`: present (0) retries, absent (clean 1) is unrecoverable, and timeout/spawn/
          ref-read failures are unknown. Deferral wins over any sibling absent repo because a task
          is not proven unrecoverable while even one sub-repo's branch state cannot be read.
          */
          const branchEvidence = entry.branch
            ? await host.probeRepoBranch(repoRootDir, entry.branch)
            : "absent";
          if (branchEvidence === "absent") {
            unrecoverableRepos.push(repoRel);
          } else if (branchEvidence === "unknown") {
            evidenceUnavailableRepos.push(repoRel);
          } else {
            unlandedRepos.push(repoRel);
          }
        }

        const auditor = createRunAuditor(host.store, {
          runId: generateSyntheticRunId("self-healing-workspace-partial-land", task.id),
          agentId: "self-healing",
          taskId: task.id,
          taskLineageId: task.lineageId,
          phase: "reconcile-workspace-partial-land",
        });

        if (evidenceUnavailableRepos.length > 0) {
          /*
          FNXC:WorkspaceFinalization 2026-08-21-09:09:
          Evidence-unavailable recovery shares the task-owned transient ceiling with lease and
          publication failures. A process-local defer map resets on restart and would otherwise
          turn an unreadable repository into an infinite five-minute recovery loop.
          */
          const defers = (task.mergeTransientRetryCount ?? 0) + 1;
          await host.store.updateTask(task.id, { mergeTransientRetryCount: defers });
          if (defers >= MAX_STARVATION_DROPS) {
            const error = `Workspace partial-land evidence unavailable: branch state could not be read after ${MAX_STARVATION_DROPS} sweeps for sub-repo(s) ${evidenceUnavailableRepos.join(", ")} — manual intervention required.`;
            await host.store.updateTask(task.id, { status: "failed", error });
            await host.store.logEntry(task.id, error);
            await auditor.database({
              type: "task:reconcile-workspace-partial-land",
              target: task.id,
              metadata: { taskId: task.id, landedRepos, unlandedRepos, failedRepos: unrecoverableRepos, evidenceUnavailableRepos, action: "park-failed", reason: "evidence-unavailable-exhausted" },
            }).catch(() => undefined);
            log.warn(`reconcileWorkspacePartialLands: parked ${task.id} failed after unavailable evidence (${evidenceUnavailableRepos.join(", ")})`);
            recovered++;
          } else {
            await emitWorkspacePartialLandNoAction(host, task, "evidence-unavailable", []);
          }
          continue;
        }

        if (unrecoverableRepos.length > 0) {
          const missingBranches = unrecoverableRepos
            .map((repoRel) => workspaceWorktrees[repoRel]?.branch ?? resolveTaskWorkingBranch(task))
            .join(", ");
          const error = `Workspace partial-land unrecoverable: sub-repo(s) ${unrecoverableRepos.join(", ")} have no branch (${missingBranches}) and no landedSha — manual intervention required.`;
          /*
          FNXC:Workspace 2026-08-15-07:17:
          This is the third and final writer of the display-only failure breadcrumb. Persist each
          repo sequentially because the helper fresh-reads then replaces the JSON map; concurrent
          writes could otherwise lose sibling breadcrumbs. Best-effort persistence must never
          influence FORK-A's pre-existing park classification or decision.
          */
          for (const repoRel of unrecoverableRepos) {
            const entry = workspaceWorktrees[repoRel];
            await persistWorkspaceRepoLandFailure(host.store, task.id, repoRel, {
              message: "Workspace branch is gone and the repository is provably not landed; manual intervention required.",
              at: new Date().toISOString(),
              branch: entry?.branch,
            }).catch(() => undefined);
          }
          await host.store.updateTask(task.id, { status: "failed", error });
          await host.store.logEntry(task.id, error);
          await auditor.database({
            type: "task:reconcile-workspace-partial-land",
            target: task.id,
            metadata: { taskId: task.id, landedRepos, unlandedRepos, failedRepos: unrecoverableRepos, action: "park-failed", reason: "branch-gone-and-unlanded" },
          }).catch(() => undefined);
          log.warn(`reconcileWorkspacePartialLands: parked ${task.id} failed (unrecoverable repos: ${unrecoverableRepos.join(", ")})`);
          recovered++;
          continue;
        }

        if (unlandedRepos.length === 0) {
          await enqueueWorkspaceMergeBounded(host, task, auditor, {
            landedRepos,
            unlandedRepos: [],
            reason: "all-landed-not-finalized",
            successLog: "Workspace merge recovery scheduled: all sub-repositories have proven landing evidence; awaiting finalize-once result",
          });
          recovered++;
          continue;
        }

        await enqueueWorkspaceMergeBounded(host, task, auditor, {
          landedRepos,
          unlandedRepos,
          reason: landedRepos.length > 0 ? "partial-land" : "zero-land",
          successLog: `Workspace merge recovery scheduled: ${landedRepos.length} landed, ${unlandedRepos.length} pending`,
        });
        recovered++;
      } catch (err: unknown) {
        log.error(`reconcileWorkspacePartialLands: failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (recovered > 0) log.log(`reconcileWorkspacePartialLands: recovered ${recovered} workspace task(s)`);
    return recovered;
  } catch (err: unknown) {
    log.error(`reconcileWorkspacePartialLands sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

export async function reclaimPhantomWorkspaceLandLeases(host: WorkspaceReconcileHost): Promise<number> {
  try {
    const settings = await host.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return 0;

    const entries = activeSessionRegistry.entriesByKind("workspace-repo-land");

    /* FNXC:Workspace 2026-08-15-12:00: durable rows must be swept even on a
       node with no local registry entries; local state cannot represent peers. */
    const leaseOwnerCompleteColumns = await resolveProjectColumnsForRoles(host.store, ["complete"]);
    const leaseOwnerArchivedColumns = await resolveProjectColumnsForRoles(host.store, ["archived"]);

    const graceMs = settings.taskStuckTimeoutMs ?? STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS;
    const staleFloorMs = graceMs * PHANTOM_EXECUTOR_BINDING_AGE_MULTIPLIER;
    const activeMergeTaskId = host.options.getActiveMergeTaskId?.() ?? null;
    const now = Date.now();

    let reclaimed = 0;
    const inspectLeases = (host.store as Partial<TaskStore>).inspectWorkspaceLeases;
    const reclaimLease = (host.store as Partial<TaskStore>).reclaimWorkspaceLease;
    if (typeof inspectLeases === "function" && typeof reclaimLease === "function") {
      try {
        const leases = await inspectLeases.call(host.store);
        for (const lease of leases) {
          if ((lease.kind !== "land" && lease.kind !== "acquire") || lease.status !== "held") continue;
          const ageMs = now - Date.parse(lease.acquiredAt);
          if (!Number.isFinite(ageMs) || ageMs < staleFloorMs) continue;
          if (await host.options.isMergePending?.(lease.owner.taskId) === true) continue;
          const result = await reclaimLease.call(host.store, {
            leaseKey: lease.leaseKey,
            expectedOwner: lease.owner,
            expectedFenceToken: lease.fenceToken,
            requireTerminalOwner: true,
            reason: "phantom-workspace-land-lease",
          });
          if (result.outcome === "reclaimed") reclaimed++;
        }
      } catch (error: unknown) {
        log.warn(`reclaimPhantomWorkspaceLandLeases durable sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const entry of entries) {
      try {
        const ageMs = now - entry.registeredAt;
        if (ageMs < staleFloorMs) continue;
        if (activeMergeTaskId && activeMergeTaskId === entry.taskId) continue;
        if (executingTaskLock.has(entry.taskId) || host.options.isTaskActive?.(entry.taskId) === true) continue;
        if (await host.options.isMergePending?.(entry.taskId) === true) continue;

        const owner = await host.store.getTask(entry.taskId).catch(() => null);
        const ownerColumn = owner?.column ?? "deleted";
        const ownerTerminalReason = workspaceOwnerTerminalReason(owner, leaseOwnerCompleteColumns, leaseOwnerArchivedColumns);
        if (isWorkspaceOwnerLive(owner, leaseOwnerCompleteColumns, leaseOwnerArchivedColumns)) continue;

        activeSessionRegistry.unregisterPath(entry.path);
        await createRunAuditor(host.store, {
          runId: generateSyntheticRunId("self-healing-phantom-workspace-land-lease", entry.taskId),
          agentId: "self-healing",
          taskId: entry.taskId,
          phase: "reclaim-phantom-workspace-land-lease",
        }).database({
          type: "task:reclaim-phantom-workspace-land-lease",
          target: entry.taskId,
          metadata: { taskId: entry.taskId, path: entry.path, kind: entry.kind, registeredAt: entry.registeredAt, ageMs, staleBindingAgeFloorMs: staleFloorMs, ownerColumn, ownerTerminalReason },
        }).catch(() => undefined);
        log.warn(`reclaimPhantomWorkspaceLandLeases: reclaimed leaked land lease on ${entry.path} (owner ${entry.taskId}, age ${ageMs}ms)`);
        reclaimed++;
      } catch (err: unknown) {
        log.error(`reclaimPhantomWorkspaceLandLeases: failed for ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (reclaimed > 0) log.log(`reclaimPhantomWorkspaceLandLeases: reclaimed ${reclaimed} leaked lease(s)`);
    return reclaimed;
  } catch (err: unknown) {
    log.error(`reclaimPhantomWorkspaceLandLeases sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

export async function reconcilePreExecutionWorktrees(host: WorkspaceReconcileHost): Promise<number> {
  try {
    const release = host.options.releasePreExecutionWorktree;
    if (!release) return 0;
    const settings = await host.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return 0;

    const now = Date.now();
    const preExecLiveColumns = await resolveProjectColumnsForRoles(
      host.store,
      ["intake", "hold", "countsTowardWip", ...REVIEW_ROLES, "complete"],
    );
    const parked = await host.store.listTasks({ slim: true });
    const candidates = parked.filter((task) => {
      if (!task.worktree || task.deletedAt) return false;
      if (task.firstExecutionAt || task.executionStartedAt) return false;
      if (preExecLiveColumns.has(task.column)) return false;
      if (task.paused || task.userPaused) return false;
      if (task.status != null) return false;
      if (task.blockedBy || task.overlapBlockedBy || task.nextRecoveryAt) return false;
      const lastTouchedMs = Math.max(
        Date.parse(task.columnMovedAt ?? "") || 0,
        Date.parse(task.updatedAt ?? "") || 0,
      );
      if (!lastTouchedMs) return false;
      return now - lastTouchedMs >= PRE_EXECUTION_WORKTREE_MAX_IDLE_MS;
    });
    if (candidates.length === 0) return 0;

    let released = 0;
    for (const task of candidates) {
      try {
        if (await release(task.id, `parked pre-execution in '${task.column}'`)) released++;
      } catch (err: unknown) {
        log.warn(`reconcilePreExecutionWorktrees: release failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (released > 0) log.log(`reconcilePreExecutionWorktrees: released ${released} pre-execution worktree(s)`);
    return released;
  } catch (err: unknown) {
    log.error(`reconcilePreExecutionWorktrees sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

export async function reconcileOrphanedWorkspaceWorktrees(host: WorkspaceReconcileHost): Promise<number> {
  try {
    const settings = await host.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return 0;
    const now = Date.now();
    const archivedColumns = new Set(await resolveProjectColumnsForRoles(host.store, ["archived"]));
    const allRows = await host.store.listTasks({ slim: true, includeDeleted: true });
    const completeColumns = new Set(await resolveProjectColumnsForRoles(host.store, ["complete"]));
    for (const column of completeColumns) {
      for (const row of await host.store.listTasks({ column, slim: true })) {
        if (!allRows.some((known) => known.id === row.id)) allRows.push(row);
      }
    }
    type Lane = "complete" | "failed" | "soft-deleted";
    type Candidate = { task: Task; lane: Lane };
    const candidates: Candidate[] = [];
    for (const task of allRows) {
      if (!isWorkspaceTask(task)) continue;
      if (archivedColumns.has(task.column)) continue;
      /*
      FNXC:Workspace 2026-08-15-06:11:
      Complete-lane placement proves no retry floor is needed, not that ownership has ended. Every
      destructive terminal teardown must still yield to pauses, scheduled recovery, executor/task
      liveness, and queued or active merge work before considering its lane-specific eligibility.
      */
      if (task.paused || task.userPaused || task.nextRecoveryAt
        || isWorkspaceTaskLive(task, host.options.isTaskActive).live
        || await host.options.isMergePending?.(task.id) === true
        || host.options.getActiveMergeTaskId?.() === task.id) continue;
      if (completeColumns.has(task.column) || host.isLegacyCompleteColumnForWorkspaceTeardown(task.column)) {
        candidates.push({ task, lane: "complete" });
        continue;
      }
      const lane: Lane | null = task.deletedAt ? "soft-deleted" : task.status === "failed" ? "failed" : null;
      if (!lane) continue;
      const touched = Math.max(Date.parse(task.columnMovedAt ?? "") || 0, Date.parse(task.updatedAt ?? "") || 0, Date.parse(task.deletedAt ?? "") || 0);
      if (!touched || now - touched < TERMINAL_WORKSPACE_WORKTREE_TEARDOWN_MIN_IDLE_MS) continue;
      if (isWorkspaceTaskLive(task, host.options.isTaskActive).live || await host.options.isMergePending?.(task.id) === true || host.options.getActiveMergeTaskId?.() === task.id) continue;
      candidates.push({ task, lane });
    }
    if (!candidates.length) return 0;

    const canonicalPath = (value: string): string => {
      const absolute = resolve(value);
      try { return realpathSync(absolute); } catch {
        /*
        FNXC:Workspace 2026-08-15-05:33:
        A manually removed worktree has no leaf to realpath. Canonicalize its existing parent so
        /var and /private/var aliases still share one destructive claim and one retry budget.
        */
        try { return join(realpathSync(dirname(absolute)), basename(absolute)); } catch { return absolute; }
      }
    };
    type Claim = { taskId: string; repoRel: string; candidate: boolean };
    const pathClaims = new Map<string, Claim[]>();
    const branchClaims = new Map<string, Claim[]>();
    const candidateIds = new Set(candidates.map(({ task }) => task.id));
    /*
    FNXC:Workspace 2026-08-15-05:33:
    Terminal cleanup is destructive, so claims are indexed across every forensic row before any
    git call. A shared path or branch may still belong to a live row; ambiguity is always skipped.
    */
    for (const task of allRows) for (const [repoRel, entry] of Object.entries(task.workspaceWorktrees ?? {})) {
      const claim = { taskId: task.id, repoRel, candidate: candidateIds.has(task.id) };
      if (entry?.worktreePath) {
        const key = canonicalPath(entry.worktreePath);
        pathClaims.set(key, [...(pathClaims.get(key) ?? []), claim]);
      }
      if (entry?.branch) {
        const branchKey = `${repoRel}::${entry.branch}`;
        branchClaims.set(branchKey, [...(branchClaims.get(branchKey) ?? []), claim]);
      }
    }
    let cleaned = 0;
    for (const { task, lane } of candidates) for (const [repoRel, entry] of Object.entries(task.workspaceWorktrees ?? {})) {
      const worktreePath = entry?.worktreePath;
      if (!worktreePath) continue;
      const pathKey = canonicalPath(worktreePath);
      const entryKey = `${task.id}::${repoRel}::${pathKey}`;
      if (host.settledWorkspaceWorktreeTeardowns.has(entryKey) || (host.orphanWorktreeRemovalFailures.get(entryKey) ?? 0) >= MAX_STARVATION_DROPS) continue;
      const repoRootDir = join(host.options.rootDir, repoRel);
      const canonicalRootDir = canonicalPath(host.options.rootDir);
      const claims = pathClaims.get(pathKey) ?? [];
      const uniqueClaims = new Set(claims.map((claim) => `${claim.taskId}::${claim.repoRel}`));
      // FNXC:Workspace 2026-08-15-05:13: destructive terminal cleanup treats shared, foreign, and
      // misattributed paths as ambiguous. Skipping is safer than deleting another row's worktree.
      if (uniqueClaims.size !== 1 || claims.some((claim) => !claim.candidate)
        || !relative(canonicalRootDir, pathKey) || relative(canonicalRootDir, pathKey).startsWith("..")
        || pathKey === canonicalRootDir || pathKey === canonicalPath(repoRootDir) || pathKey === canonicalPath(join(repoRootDir, ".git"))) continue;
      const resolvedPath = resolve(worktreePath);
      if (activeSessionRegistry.isPathActive(worktreePath) || activeSessionRegistry.isPathActive(resolvedPath) || activeSessionRegistry.isPathActive(pathKey)) continue;
      const branch = entry.branch;
      const branchKey = branch ? `${repoRel}::${branch}` : "";
      const branchClaimCount = branch ? new Set((branchClaims.get(branchKey) ?? []).map((claim) => claim.taskId)).size : 0;
      const pruneCompleted = host.prunedWorkspaceWorktreeTeardowns.has(entryKey);
      if (pruneCompleted && branchClaimCount > 1) continue;
      let failed = false;
      let worktreeGone = pruneCompleted || !existsSync(worktreePath);
      let pruned = pruneCompleted;
      let branchOutcome = "absent";
      try {
        if (!worktreeGone) {
          const listing = await host.execWorkspaceTeardownGit("git worktree list --porcelain", { cwd: repoRootDir, timeout: 120_000 });
          const owned = listing.stdout.split("\n").some((line) => line.startsWith("worktree ") && canonicalPath(line.slice(9)) === pathKey);
          /* FNXC:Workspace 2026-08-15-05:33: Only the attributed sub-repo may prove a directory removable. */
          if (!owned) continue;
          await host.execWorkspaceTeardownGit(`git worktree remove --force ${shellQuote(worktreePath)}`, { cwd: repoRootDir, timeout: 120_000 });
          worktreeGone = !existsSync(worktreePath);
        }
        if (!pruneCompleted) {
          await host.execWorkspaceTeardownGit("git worktree prune", { cwd: repoRootDir, timeout: 120_000 });
          pruned = true;
          host.prunedWorkspaceWorktreeTeardowns.add(entryKey);
        }
        /*
        FNXC:WorkspaceBranchDeletion 2026-08-20-03:39:
        Workspace teardown remains conservative: canonical spelling is not provenance proof,
        so delete only when the core classifier accepts this task branch.
        */
        if (branch && isFusionDeletableBranch(task, branch) && worktreeGone) {
          if (branchClaimCount > 1) branchOutcome = "retained-duplicate-claim";
          else {
            /*
            FNXC:Workspace 2026-08-15-06:11:
            A failed row's recorded landed SHA is evidence to verify, never an operator discard
            instruction. Use the canonical landed predicate against this sub-repo's integration
            branch; only soft deletion authorizes discard without land proof.
            */
            let safe = Boolean(task.deletedAt);
            if (!safe && entry.landedSha) {
              const baseResolution = await resolveWorkspaceRepoBaseBranch({
                mode: "recorded",
                repoRootDir,
                repoRelPath: repoRel,
                task,
                settings,
                recordedBaseBranch: entry.baseBranch,
              });
              await recordWorkspaceBaseBranchDecision({
                store: host.store,
                audit: createRunAuditor(host.store, {
                  runId: generateSyntheticRunId("workspace-repo-base-branch", task.id),
                  agentId: "system:self-healing",
                  phase: "workspace-repo-base-branch",
                }),
                task,
                repoRelPath: repoRel,
                repoAbsPath: repoRootDir,
                resolution: baseResolution,
                stage: "self-heal",
              });
              safe = await isRepoLanded(repoRootDir, baseResolution.branch, entry.landedSha, task.id, branch, entry.revertBoundarySha, task.createdAt);
            }
            if (!safe && entry.baseCommitSha) {
              const count = await host.execWorkspaceTeardownGit(`git rev-list --count ${shellQuote(entry.baseCommitSha)}..${shellQuote(branch)}`, { cwd: repoRootDir, timeout: 120_000 });
              safe = count.stdout.trim() === "0";
            }
            if (safe) {
              /* FNXC:Workspace 2026-08-15-05:33: An absent ref is already a completed teardown, not retryable failure. */
              const listed = await host.execWorkspaceTeardownGit(`git branch --list ${shellQuote(branch)}`, { cwd: repoRootDir, timeout: 120_000 });
              if (!listed.stdout.trim()) branchOutcome = "absent";
              else {
                await host.execWorkspaceTeardownGit(`git branch -D ${shellQuote(branch)}`, { cwd: repoRootDir, timeout: 120_000 });
                branchOutcome = "deleted";
              }
            } else branchOutcome = "retained-unlanded";
          }
        } else if (branch) branchOutcome = "retained-non-canonical";
      } catch (err: unknown) {
        failed = true;
        log.warn(`reconcileOrphanedWorkspaceWorktrees: git teardown failed for ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const attempt = failed ? (host.orphanWorktreeRemovalFailures.get(entryKey) ?? 0) + 1 : host.orphanWorktreeRemovalFailures.get(entryKey) ?? 0;
      if (failed) host.orphanWorktreeRemovalFailures.set(entryKey, attempt);
      /* FNXC:Workspace 2026-08-15-05:33: A duplicate branch claim remains eligible after ambiguity clears. */
      const settled = !failed && worktreeGone && pruned && ["deleted", "absent", "retained-unlanded", "retained-non-canonical"].includes(branchOutcome);
      if (settled) {
        host.orphanWorktreeRemovalFailures.delete(entryKey);
        host.settledWorkspaceWorktreeTeardowns.add(entryKey);
        cleaned++;
        try {
          /*
          FNXC:Workspace 2026-08-15-05:33:
          Settlement retires only the disposable path. Retained branches preserve their branch/base/
          landed evidence for operator recovery and later safe deletion; deleting the whole entry
          would turn a safe retain into a permanent leak.
          */
          /*
          FNXC:Workspace 2026-08-15-08:00:
          Teardown settles one durable repository entry. The store-level advisory-locked merge
          refreshes the map under the task's composite project scope, so this best-effort sweep
          cannot erase a sibling acquisition or landed-SHA mutation that raced its stale task scan.
          */
          await host.store.mergeWorkspaceWorktreeEntry(
            task.id,
            repoRel,
            { worktreePath: "" },
            { requireExistingEntry: true },
          );
        } catch { /* soft-deleted rows may reject best-effort settlement */ }
      }
      /*
      FNXC:CodeOrganization 2026-08-13-03:33:
      Run-audit metadata stays ids/counts/outcomes-only. Git teardown failures use a closed
      outcome code here; the unbounded git error stays in the operator log only.
      */
      try {
        await createRunAuditor(host.store, {
          runId: generateSyntheticRunId("self-healing-orphaned-workspace-worktree", task.id),
          agentId: "self-healing",
          taskId: task.id,
          taskLineageId: task.lineageId,
          phase: "reconcile-orphaned-workspace-worktree",
        }).database({
          type: "task:reconcile-orphaned-workspace-worktree",
          target: task.id,
          metadata: {
            taskId: task.id,
            repo: repoRel,
            worktreePath,
            success: settled,
            reason: failed ? "git-teardown-failed" : "settled",
            lane,
            worktreeOutcome: worktreeGone ? "gone" : "present",
            pruned,
            branch: entry.branch,
            branchOutcome,
            attempt,
          },
        });
      } catch { /* audit best-effort */ }
    }
    /*
    FNXC:CodeOrganization 2026-09-04-04:43:
    After every candidate's per-repo entries settle, FN-268 removes the unified task directory
    when it is empty. Legacy layouts stay not-applicable; a still-unsettled entry retains the
    directory so teardown cannot delete a live sibling path.
    */
    for (const { task, lane } of candidates) {
      const taskDir = resolveWorkspaceTaskWorktreeDir(host.options.rootDir, settings, task.id);
      let taskDirectoryOutcome: "removed" | "retained" | "not-applicable" = "not-applicable";
      if (!isLegacyWorkspaceWorktreeLayout(task, taskDir)) {
        const entries = Object.entries(task.workspaceWorktrees ?? {});
        const everyEntrySettled = entries.every(([repoRel, entry]) => {
          if (!entry.worktreePath) return true;
          const entryKey = `${task.id}::${repoRel}::${canonicalPath(entry.worktreePath)}`;
          return host.settledWorkspaceWorktreeTeardowns.has(entryKey);
        });
        if (!everyEntrySettled) {
          taskDirectoryOutcome = "retained";
        } else if (existsSync(taskDir)) {
          taskDirectoryOutcome = removeEmptyWorkspaceTaskDirectory(
            taskDir,
            entries.map(([, entry]) => entry.worktreePath).filter(Boolean),
          ) ? "removed" : "retained";
        }
      }
      try {
        await createRunAuditor(host.store, {
          runId: generateSyntheticRunId("self-healing-orphaned-workspace-worktree", task.id),
          agentId: "self-healing",
          taskId: task.id,
          taskLineageId: task.lineageId,
          phase: "reconcile-orphaned-workspace-worktree",
        }).database({
          type: "task:reconcile-orphaned-workspace-worktree",
          target: task.id,
          metadata: {
            taskId: task.id,
            repo: "task-directory",
            success: taskDirectoryOutcome !== "retained",
            reason: "task-directory",
            lane,
            taskDirectoryOutcome,
          },
        });
      } catch { /* audit best-effort */ }
    }
    return cleaned;
  } catch (err: unknown) {
    log.error(`reconcileOrphanedWorkspaceWorktrees sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
