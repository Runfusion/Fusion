/**
 * FNXC:CodeOrganization 2026-08-03-12:20:
 * buildForeachWorktreeDeps peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowForeach 2026-08-03-12:20 (U10 / KTD-11):
 * Build worktree-isolation + ordered-integration + parallel-scheduling deps for a
 * graph-owned foreach. Per-instance worktrees branch off the task main tip;
 * integration rebases each branch in step order; projection flips done-iff-integrated.
 * Best-effort: a git failure routes the foreach to a clean failure rather than crashing the run.
 */
import type { Task, TaskStore } from "@fusion/core";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getConflictedFiles } from "../merger.js";
import {
  canonicalStepInstanceBranchName,
  resolveTaskWorkingBranch,
} from "../worktree/worktree-names.js";
import { resolveTaskWorktreePath } from "../worktree/worktree-paths.js";
import type {
  IntegrationAttemptResult,
  IntegrationGitOps,
  IntegrationProjection,
} from "../execution/step-integration.js";
import type { WorkflowStepInstanceState } from "../workflows/workflow-graph-foreach.js";
import { executorLog } from "../logger.js";

const execAsync = promisify(exec);

export type BuildForeachWorktreeDepsBag = {
  store: TaskStore;
  rootDir: string;
  createWorktree: (
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
  ) => Promise<{ path: string; branch: string }>;
  semaphoreAvailableCount: () => number;
};

export type ForeachWorktreeDeps = {
  allocateInstanceWorktree: (
    stepIndex: number,
    base: string | undefined,
  ) => Promise<{ worktreePath: string; branchName: string }>;
  resolveIntegrationBase: () => Promise<string | undefined>;
  integrationGitOps: IntegrationGitOps;
  integrationProjection: IntegrationProjection;
  semaphoreAvailability: () => number;
  resumeReconcile: (
    pinned: number,
  ) => Promise<Array<{ stepIndex: number; disposition: "integrated" | "reintegrate" | "rerun"; branchName?: string }>>;
};

/**
 * Build the worktree-isolation + ordered-integration + parallel-scheduling deps
 * for a graph-owned foreach (KTD-11, U10). Returns the additive set the
 * WorkflowGraphTaskRunner forwards to the foreach sub-walk:
 *
 *   - `allocateInstanceWorktree(i, base)` — a per-instance worktree on a
 *     canonical `fusion/<task>-step-<i>` branch off `base` (the main tip),
 *     created via the existing `createWorktree` path (the file-scope guard the
 *     session machinery installs applies unchanged to anything the instance
 *     session commits in this worktree — we do NOT bypass it);
 *   - `resolveIntegrationBase()` — the task's main branch tip, re-read before each
 *     (re)allocation so a rework lands on the UPDATED base;
 *   - `integrationGitOps` — rebase the instance branch onto the main branch in
 *     the instance worktree (branch is checked out there), fast-forward main on
 *     success from the MAIN worktree; on conflict reuse merger.ts
 *     `getConflictedFiles` (NOT reimplemented) and abort the rebase so the next
 *     instance can integrate; `discardBranch` deletes the branch + frees the
 *     instance worktree (pool hygiene);
 *   - `integrationProjection` — projection-first ordering (KTD-7): `markStepDone`
 *     flips the step `done` via `updateStep(source:"graph")` (the dependency-order
 *     guard admits it), THEN `markInstanceIntegrated` flips the persisted row;
 *   - `semaphoreAvailability` — the live free-slot count so parallel scheduling
 *     clamps without hold-and-wait.
 *
 * Best-effort throughout: a git failure routes the foreach to a clean failure
 * (parked for human review) rather than crashing the run.
 */
export function buildForeachWorktreeDeps(
  deps: BuildForeachWorktreeDepsBag,
  task: Task,
  runId?: string,
): ForeachWorktreeDeps {
  const taskId = task.id;
  // Per-instance worktree paths, so discard can free them.
  const instancePaths = new Map<number, string>();

  const mainWorktree = async (): Promise<string> => {
    try {
      return (await deps.store.getTask(taskId)).worktree || deps.rootDir;
    } catch {
      return deps.rootDir;
    }
  };
  const mainBranch = async (): Promise<string> => {
    try {
      const detail = await deps.store.getTask(taskId);
      return resolveTaskWorkingBranch(detail);
    } catch {
      return resolveTaskWorkingBranch(task);
    }
  };

  return {
    resolveIntegrationBase: async (): Promise<string | undefined> => {
      // The main branch tip (HEAD of the task's working branch in its worktree).
      try {
        const { stdout } = await execAsync("git rev-parse HEAD", { cwd: await mainWorktree() });
        const sha = stdout.trim();
        return sha.length > 0 ? sha : await mainBranch();
      } catch {
        return await mainBranch();
      }
    },
    allocateInstanceWorktree: async (stepIndex, base): Promise<{ worktreePath: string; branchName: string }> => {
      const branchName = canonicalStepInstanceBranchName(taskId, stepIndex);
      const worktreePath = resolveTaskWorktreePath(
        deps.rootDir,
        undefined,
        `${taskId.toLowerCase()}-step-${stepIndex}`,
      );
      // createWorktree installs the file-scope guard (session machinery,
      // unchanged) and branches off `base` (the integration base / updated tip).
      const created = await deps.createWorktree(branchName, worktreePath, taskId, base);
      instancePaths.set(stepIndex, created.path);
      return { worktreePath: created.path, branchName: created.branch };
    },
    integrationGitOps: {
      integrate: async (branchName, stepIndex): Promise<IntegrationAttemptResult> => {
        const cwd = await mainWorktree();
        const target = await mainBranch();
        // The instance branch is checked out in its OWN worktree, so the rebase
        // (which checks out `branchName`) must run THERE — running it from the
        // main worktree fails with "branch is already checked out in another
        // worktree". The final fast-forward merge still runs from the main
        // worktree (it only advances `target`, which is checked out there).
        const instanceCwd = instancePaths.get(stepIndex) ?? cwd;
        try {
          // Rebase the instance branch onto the current main tip (in its own
          // worktree), then ff main from the main worktree.
          await execAsync(`git rebase ${target} ${branchName}`, { cwd: instanceCwd });
          await execAsync(`git checkout ${target}`, { cwd });
          await execAsync(`git merge --ff-only ${branchName}`, { cwd });
          return { kind: "integrated", integratedAt: new Date().toISOString() };
        } catch (err) {
          // Conflict (or other rebase failure): classify via merger helper, abort.
          // The rebase ran in the instance worktree, so conflicts live there and
          // the abort must target that same cwd.
          const conflictedFiles = await getConflictedFiles(instanceCwd);
          try {
            await execAsync("git rebase --abort", { cwd: instanceCwd });
          } catch {
            // best-effort; leave the worktree recoverable.
          }
          // Restore main checkout so the next instance integrates cleanly.
          try {
            await execAsync(`git checkout ${target}`, { cwd });
          } catch {
            // best-effort.
          }
          executorLog.warn(
            `[step-integration] ${taskId} step ${stepIndex} branch ${branchName} conflict: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { kind: "conflict", conflictedFiles };
        }
      },
      discardBranch: async (branchName, stepIndex): Promise<void> => {
        const cwd = await mainWorktree();
        const path = instancePaths.get(stepIndex);
        if (path) {
          // Remove the instance worktree (pool hygiene). Best-effort; force so a
          // dirty/conflicting tree is still cleaned up.
          try {
            await execAsync(`git worktree remove --force "${path}"`, { cwd: deps.rootDir });
          } catch {
            // best-effort cleanup.
          }
          instancePaths.delete(stepIndex);
        }
        // Delete the (now-merged or conflicting) branch.
        try {
          await execAsync(`git branch -D ${branchName}`, { cwd });
        } catch {
          // best-effort — the branch may already be gone.
        }
      },
    },
    integrationProjection: {
      markStepDone: async (stepIndex): Promise<void> => {
        // Projection-first (KTD-7): graph-source write relaxes the guard to
        // dependency order; predecessors are integrated (done) by construction.
        await deps.store.updateStep(taskId, stepIndex, "done", { source: "graph" });
      },
      markInstanceIntegrated: async (stepIndex, integratedAt, identity): Promise<void> => {
        const store = deps.store as unknown as {
          saveWorkflowRunStepInstanceAsync?: (state: WorkflowStepInstanceState) => Promise<void>;
          loadWorkflowRunStepInstancesAsync?: (taskId: string, runId: string) => Promise<WorkflowStepInstanceState[]>;
          saveWorkflowRunStepInstance?: (state: WorkflowStepInstanceState) => void;
          loadWorkflowRunStepInstances?: (taskId: string, runId: string) => WorkflowStepInstanceState[];
        };
        if (typeof store.saveWorkflowRunStepInstanceAsync !== "function" && typeof store.saveWorkflowRunStepInstance !== "function") return;
        // The upsert is keyed by (taskId, runId, foreachNodeId, stepIndex). The
        // queue passes the REAL identity (the same runId + foreachNodeId the
        // foreach sub-walk persisted the row under) so this FLIPS the existing
        // row to completed/integratedAt instead of writing an orphan (FIX 1).
        // Load the current row to preserve its fields (currentNodeId, baseline,
        // reworkCount) we don't otherwise carry on the identity.
        let existing: WorkflowStepInstanceState | undefined;
        try {
          const rows = await store.loadWorkflowRunStepInstancesAsync?.(taskId, identity.runId)
            ?? store.loadWorkflowRunStepInstances?.(taskId, identity.runId)
            ?? [];
          existing = rows.find(
            (r) => r.foreachNodeId === identity.foreachNodeId && r.stepIndex === stepIndex,
          );
        } catch {
          // Best-effort read; fall back to a minimal flip below.
        }
        try {
          await (store.saveWorkflowRunStepInstanceAsync?.({
            ...(existing ?? {}),
            taskId,
            runId: identity.runId,
            foreachNodeId: identity.foreachNodeId,
            stepIndex,
            pinnedStepCount: identity.pinnedStepCount,
            currentNodeId: existing?.currentNodeId ?? "",
            status: "completed",
            reworkCount: existing?.reworkCount ?? 0,
            branchName: identity.branchName || canonicalStepInstanceBranchName(taskId, stepIndex),
            integratedAt,
          } as WorkflowStepInstanceState) ?? store.saveWorkflowRunStepInstance?.({
            ...(existing ?? {}),
            taskId,
            runId: identity.runId,
            foreachNodeId: identity.foreachNodeId,
            stepIndex,
            pinnedStepCount: identity.pinnedStepCount,
            currentNodeId: existing?.currentNodeId ?? "",
            status: "completed",
            reworkCount: existing?.reworkCount ?? 0,
            branchName: identity.branchName || canonicalStepInstanceBranchName(taskId, stepIndex),
            integratedAt,
          } as WorkflowStepInstanceState));
        } catch {
          // Persistence is additive bookkeeping — never fail the integration.
        }
      },
    },
    semaphoreAvailability: (): number => deps.semaphoreAvailableCount(),
    resumeReconcile: async (
      pinned,
    ): Promise<Array<{ stepIndex: number; disposition: "integrated" | "reintegrate" | "rerun"; branchName?: string }>> => {
      // Crash-resume reconciliation (KTD-11): reconcile each persisted instance
      // row against branch existence. integrated → done; branch exists not
      // integrated → re-enter the integration queue; branch missing → re-run.
      // NOTE (handoff): this is the per-run resume seeding only; the full
      // self-healing sweep across stale runs (recoverStaleTransitionPending
      // analogue) is out of scope for U10.
      const store = deps.store as unknown as {
        loadWorkflowRunStepInstancesAsync?: (taskId: string, runId: string) => Promise<WorkflowStepInstanceState[]>;
        loadWorkflowRunStepInstances?: (taskId: string, runId: string) => WorkflowStepInstanceState[];
      };
      if (typeof store.loadWorkflowRunStepInstancesAsync !== "function" && typeof store.loadWorkflowRunStepInstances !== "function") return [];
      let rows: WorkflowStepInstanceState[] = [];
      try {
        // Load under the REAL run id (threaded) so resume actually sees the rows
        // the sub-walk persisted; the legacy literal is the unthreaded fallback.
        rows = await store.loadWorkflowRunStepInstancesAsync?.(taskId, runId ?? `${taskId}:run`)
          ?? store.loadWorkflowRunStepInstances?.(taskId, runId ?? `${taskId}:run`)
          ?? [];
      } catch {
        return [];
      }
      const cwd = await mainWorktree();
      const out: Array<{ stepIndex: number; disposition: "integrated" | "reintegrate" | "rerun"; branchName?: string }> = [];
      for (const row of rows) {
        if (row.stepIndex < 0 || row.stepIndex >= pinned) continue;
        if (row.status === "completed" || row.integratedAt) {
          out.push({ stepIndex: row.stepIndex, disposition: "integrated" });
          continue;
        }
        const branchName = row.branchName || canonicalStepInstanceBranchName(taskId, row.stepIndex);
        let branchExists = false;
        try {
          await execAsync(`git rev-parse --verify --quiet ${branchName}`, { cwd });
          branchExists = true;
        } catch {
          branchExists = false;
        }
        if (branchExists && row.status === "awaiting-integration") {
          out.push({ stepIndex: row.stepIndex, disposition: "reintegrate", branchName });
        } else {
          out.push({ stepIndex: row.stepIndex, disposition: "rerun" });
        }
      }
      return out;
    },
  };
}
