/**
 * FNXC:CodeOrganization 2026-08-03-11:55:
 * runProjectedGraphTaskStep peeled from TaskExecutor (U4).
 *
 * Project a graph-owned step only after it has a real worktree. A fresh task has no
 * worktree until the authoritative implementation pass acquires one. Projecting before
 * that pass produces a false "step started" event and captures the baseline from the
 * project root. In that fresh path, let the implementation pass own the first projection
 * and reuse the base SHA it captures during worktree acquisition. Resumed and
 * isolated-step runs already have a worktree, so they keep the normal per-step
 * projection and pre-work baseline behavior.
 *
 * FNXC:BaselineCwdGating 2026-07-21-19:21:
 * FN-8464 requires graph step projection to defer until the candidate is a real directory.
 * A stale/non-directory path must follow fresh-worktree ordering so runTaskStep never spawns
 * baseline git with an unusable cwd.
 */
import type { Task, TaskDetail, TaskStore, ThinkingLevel } from "@fusion/core";
import type { ImplementationExit } from "./implementation-exit.js";
import { runTaskStep, isUsableWorktreeDirectory, type RunTaskStepResult } from "../execution/step-runner.js";

export type ForeachActiveContextLite = {
  instanceId?: string;
  worktreePath?: string | null;
  deferDoneToReview?: boolean;
};

export type RunProjectedGraphTaskStepDeps = {
  store: TaskStore;
  runGraphTaskStep: (
    task: Task,
    stepIndex: number,
    instanceId?: string,
    governingNodeId?: string,
    thinkingLevel?: ThinkingLevel,
    skillName?: string,
  ) => Promise<{ success: boolean; error?: string; exit?: ImplementationExit }>;
};

export async function runProjectedGraphTaskStep(
  deps: RunProjectedGraphTaskStepDeps,
  task: Task,
  live: TaskDetail,
  stepIndex: number,
  active: ForeachActiveContextLite,
  governingNodeId?: string,
  thinkingLevel?: ThinkingLevel,
  skillName?: string,
): Promise<RunTaskStepResult> {
  const worktreePath = active.worktreePath || live.worktree;
  const runStep = (idx: number) =>
    deps.runGraphTaskStep(
      task,
      idx,
      active.instanceId,
      governingNodeId,
      thinkingLevel,
      skillName,
    );

  if (!worktreePath || !isUsableWorktreeDirectory(worktreePath)) {
    const result = await runStep(stepIndex);
    const refreshed = await deps.store.getTask(task.id).catch(() => live);
    return {
      outcome: result.success ? "success" : "failure",
      baselineSha: refreshed.baseCommitSha,
      checkpointId: undefined,
      exit: result.exit,
    };
  }

  return runTaskStep(
    {
      store: deps.store,
      worktreePath,
      runStep,
    },
    { id: task.id, steps: live.steps },
    stepIndex,
    { markDoneOnSuccess: active.deferDoneToReview !== true, projectionSource: "graph" },
  );
}
