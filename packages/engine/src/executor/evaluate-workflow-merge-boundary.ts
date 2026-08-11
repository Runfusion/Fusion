/**
 * FNXC:CodeOrganization 2026-08-03-17:00:
 * evaluateWorkflowMergeBoundary + getWorkflowMergeImplementationProofFailure peeled (U4).
 *
 * Graph merge admission: node-result presence/terminality, foreach coverage, and
 * skip-bypass taint / implementation-proof failures.
 */
import type { TaskDetail, TaskStore, WorkflowIr, WorkflowStepResult as CoreWorkflowStepResult } from "@fusion/core";
import { evaluateForeachMergeProof, evaluateSkipBypassTaint, resolveWorkflowIrForTask } from "@fusion/core";

export type EvaluateWorkflowMergeBoundaryDeps = {
  store: TaskStore;
  loadMergeBoundaryInstances: (taskId: string, runId?: string) => Promise<Array<{ foreachNodeId: string; stepIndex: number; pinnedStepCount: number }>>;
};

export type WorkflowMergeBoundaryProof = {
  resolved: boolean;
  hasRelevantNodeResult: boolean;
  allResultsTerminal: boolean;
  coverageComplete: boolean;
  hasForeachStepExecute: boolean;
  missingInstanceIds: string[];
  nonTerminalResult?: CoreWorkflowStepResult;
  complete: boolean;
};

export async function evaluateWorkflowMergeBoundary(
  deps: EvaluateWorkflowMergeBoundaryDeps,
  task: TaskDetail,
  runId?: string,
): Promise<WorkflowMergeBoundaryProof> {
  const relevant = (task.workflowStepResults ?? []).filter((result) =>
    result.source === "node" && (result.phase ?? "pre-merge") === "pre-merge",
  );
  // FNXC:WorkflowMerge 2026-07-27-12:30: FN-8601 keeps required presence
  // independent from terminality: a failed node result proves execution occurred,
  // while allResultsTerminal separately rejects it at the merge boundary.
  const hasRelevantNodeResult = relevant.length > 0;
  const nonTerminalResult = relevant.find((result) => result.status !== "passed" && result.status !== "skipped");
  const allResultsTerminal = nonTerminalResult === undefined;
  let ir: WorkflowIr | undefined;
  try { ir = await resolveWorkflowIrForTask(deps.store, task.id); } catch { /* preserve legacy behavior for unresolved IRs */ }
  if (!ir) return { resolved: false, hasRelevantNodeResult, allResultsTerminal, coverageComplete: true, hasForeachStepExecute: false, missingInstanceIds: [], nonTerminalResult, complete: false };

  let persistedInstances: Array<{ foreachNodeId: string; stepIndex: number; pinnedStepCount: number }> = [];
  try { persistedInstances = await deps.loadMergeBoundaryInstances(task.id, runId); } catch { /* persistence is additive */ }
  const coverage = evaluateForeachMergeProof({ ir, steps: task.steps, workflowStepResults: task.workflowStepResults, persistedInstances });
  const complete = hasRelevantNodeResult && allResultsTerminal && coverage.missingInstanceIds.length === 0;
  return { resolved: true, hasRelevantNodeResult, allResultsTerminal, coverageComplete: coverage.missingInstanceIds.length === 0, hasForeachStepExecute: coverage.hasForeachStepExecute, missingInstanceIds: coverage.missingInstanceIds, nonTerminalResult, complete };
}

export type GetWorkflowMergeImplementationProofFailureDeps = {
  store: TaskStore;
  evaluateWorkflowMergeBoundary: (task: TaskDetail, runId?: string) => Promise<WorkflowMergeBoundaryProof>;
};

export async function getWorkflowMergeImplementationProofFailure(
  deps: GetWorkflowMergeImplementationProofFailureDeps,
  task: TaskDetail,
): Promise<string | undefined> {
  /*
  FNXC:Lifecycle 2026-07-16-21:40:
  FN-8141 — the graph merge boundary is another AUTO-promotion path. If the task is
  skip-bypass tainted (steps skipped after a bulk-step-completion refusal with no
  accepted fn_task_done), treat it as missing implementation proof so the merge is
  blocked with `implementation-incomplete` rather than laundered through a no-op merge.
  Runs before the noCommitsExpected exemption so a tainted task cannot slip past it.
  */
  const taint = evaluateSkipBypassTaint(task);
  if (taint.blocked) return "implementation did not run: steps were skipped after a bulk-step-completion refusal without an accepted fn_task_done";
  if (task.noCommitsExpected === true) return undefined;
  let ir: WorkflowIr | undefined;
  try { ir = await resolveWorkflowIrForTask(deps.store, task.id); } catch { ir = undefined; }
  if (!ir) return undefined;
  const usesParsedSteps = ir.nodes.some((node) => node.kind === "parse-steps");
  const usesExecuteSeam = ir.nodes.some((node) => node.kind === "prompt" && node.config?.seam === "execute");
  if (!usesParsedSteps && !usesExecuteSeam) return undefined;
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const hasTerminalParsedSteps = steps.length > 0 && steps.every((step) => step.status === "done" || step.status === "skipped");
  const hasModifiedFiles = (task.modifiedFiles?.length ?? 0) > 0;
  const proof = await deps.evaluateWorkflowMergeBoundary(task);
  const hasGraphNativeImplementationProof = proof.hasRelevantNodeResult && proof.allResultsTerminal && proof.coverageComplete;
  if (usesParsedSteps) {
    if (hasTerminalParsedSteps || hasGraphNativeImplementationProof) return undefined;
    return proof.hasForeachStepExecute && !proof.coverageComplete
      ? `implementation did not run: foreach step instances are incomplete (missing ${proof.missingInstanceIds.join(", ")})`
      : "implementation did not run: parsed coding steps are missing or incomplete";
  }
  if (usesExecuteSeam) return hasTerminalParsedSteps || hasModifiedFiles || hasGraphNativeImplementationProof ? undefined : "implementation did not run: execute seam has no completion proof";
  return undefined;
}
