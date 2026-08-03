/**
 * FNXC:CodeOrganization 2026-08-03-11:55:
 * runProjectedGraphTaskStep peeled from TaskExecutor (U4).
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
