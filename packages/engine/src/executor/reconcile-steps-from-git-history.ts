/**
 * FNXC:CodeOrganization 2026-08-03-09:20:
 * reconcileStepsFromGitHistory peeled from TaskExecutor (U4).
 *
 * On resume (task already has a branch from a prior run), walk git history and mark steps as
 * done when a commit matching the step-completion convention is found
 * (`feat|chore|fix(FN-XXXX): complete Step N`, case-insensitive). Prevents the agent from
 * redoing already-committed work after an auto-requeue. Called after worktree acquire and
 * before the agent session starts.
 *
 * FNXC:WorkflowResume 2026-06-30-08:02:
 * Browser Verification and Code Review REVISE intentionally reopen the trailing implementation/verification suffix. FN-7273 showed git-history resume then found older `complete Step 5` commits from the previous attempt, tried to mark Step 5 done while Step 3 was active, and logged a false reconciliation after TaskStore rejected the out-of-order write. A reopened step may only be reconciled from a commit whose author time is newer than the latest `→ pending` transition for that step, and success is logged only after the store confirms the step is terminal.
 *
 * FNXC:EngineDiagnostics 2026-08-03-05:54:
 * parse-steps source read-through is diagnostic only.
 */
import type { TaskDetail, TaskStore, WorkflowIr } from "@fusion/core";
import { resolveWorkflowIrForTask } from "@fusion/core";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";

const execAsync = promisify(exec);

export type ReconcileStepsFromGitHistoryDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  resolveTaskStepSource: (ir: WorkflowIr | undefined) =>
    | { artifact: string; parser: string }
    | undefined;
};

export async function reconcileStepsFromGitHistory(
  deps: ReconcileStepsFromGitHistoryDeps,
  taskId: string,
  detail: TaskDetail,
  worktreePath: string,
): Promise<void> {
  const baseCommitSha = detail.baseCommitSha;
  if (!baseCommitSha) return;

  // Step-inversion read-through (KTD-12, U12): for graph-owned tasks, resolve
  // which artifact/parser governs the step list from the workflow's parse-steps
  // declaration so reconcile knows the step source. The `complete step N`
  // commit convention is parser-agnostic (every parser yields the same step
  // ordering the agent commits against), so the git-history reconcile below is
  // unchanged — this read-through records the governing source for diagnostics
  // and is the seam a future parser-specific reconcile would consult. Legacy
  // tasks (no parse-steps node) resolve to undefined and are untouched.
  try {
    const ir = await resolveWorkflowIrForTask(deps.store, taskId);
    const stepSource = deps.resolveTaskStepSource(ir);
    if (stepSource) {
      executorLog.debug(`${taskId}: reconcile step source governed by parse-steps(artifact=${stepSource.artifact}, parser=${stepSource.parser})`);
    }
  } catch {
    // Read-through is diagnostic only; never block reconcile on it.
  }

  const pendingOrInProgressSteps = detail.steps.filter(
    (s, i) => (s.status === "pending" || s.status === "in-progress") && i > 0,
  );
  if (pendingOrInProgressSteps.length === 0) return;

  let logOutput: string;
  try {
    const { stdout } = await execAsync(
      `git log "${baseCommitSha}..HEAD" --format=%ct%x09%s`,
      { cwd: worktreePath },
    );
    logOutput = stdout;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    executorLog.warn(`${taskId}: reconcileStepsFromGitHistory — git log failed: ${msg}`);
    return;
  }

  if (!logOutput.trim()) return;

  const latestPendingByStep = new Map<number, number>();
  for (const entry of detail.log ?? []) {
    const action = entry.action ?? "";
    const match = action.match(/^Step (\d+) \(.+\) → pending$/);
    if (!match) continue;
    const stepIndex = Number.parseInt(match[1], 10);
    const pendingAt = Date.parse(entry.timestamp);
    if (!Number.isInteger(stepIndex) || !Number.isFinite(pendingAt)) continue;
    latestPendingByStep.set(stepIndex, Math.max(latestPendingByStep.get(stepIndex) ?? -1, pendingAt));
  }

  // Match: feat(FN-2978): complete Step 3  /  chore(fn-2978)!: Complete step 3
  const stepCommitRegex = /^(?:feat|chore|fix)\([Ff][Nn]-\d+\)(?:!)?:\s*complete\s+step\s+(\d+)/i;
  const reconciledStepIndices = new Set<number>();

  for (const line of logOutput.split("\n")) {
    const [commitSecondsRaw, ...messageParts] = line.split("\t");
    const commitMs = Number.parseInt(commitSecondsRaw ?? "", 10) * 1000;
    const message = messageParts.join("\t").trim();
    const match = message.match(stepCommitRegex);
    if (!match) continue;
    const stepIndex = parseInt(match[1], 10);
    if (Number.isNaN(stepIndex) || stepIndex < 0 || stepIndex >= detail.steps.length) continue;
    const latestPendingAt = latestPendingByStep.get(stepIndex);
    if (latestPendingAt !== undefined && (!Number.isFinite(commitMs) || commitMs <= latestPendingAt)) continue;
    const step = detail.steps[stepIndex];
    if (step.status === "pending" || step.status === "in-progress") {
      reconciledStepIndices.add(stepIndex);
    }
  }

  for (const stepIndex of reconciledStepIndices) {
    const updated = await deps.store.updateStep(taskId, stepIndex, "done");
    const updatedStepStatus = updated.steps?.[stepIndex]?.status;
    if (updatedStepStatus !== "done" && updatedStepStatus !== "skipped") {
      executorLog.warn(
        `${taskId}: skipped git-history reconciliation log for Step ${stepIndex}; store kept status ${updatedStepStatus ?? "missing"}`,
      );
      continue;
    }
    await deps.store.logEntry(
      taskId,
      `Reconciled Step ${stepIndex} as done from git history (resume)`,
      undefined,
      deps.getRunContextFor(taskId),
    );
    executorLog.log(`${taskId}: reconciled Step ${stepIndex} as done from git history`);
  }

  if (reconciledStepIndices.size > 0) {
    // Refresh task and update currentStep to the lowest pending index
    const updated = await deps.store.getTask(taskId);
    const lowestPending = updated.steps.findIndex((s) => s.status === "pending" || s.status === "in-progress");
    if (lowestPending >= 0 && lowestPending !== updated.currentStep) {
      await deps.store.updateTask(taskId, { currentStep: lowestPending });
      executorLog.log(`${taskId}: set currentStep to ${lowestPending} after step reconciliation`);
    }
  }
}
