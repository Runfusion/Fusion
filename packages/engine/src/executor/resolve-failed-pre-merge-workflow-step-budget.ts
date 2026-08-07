/**
 * FNXC:CodeOrganization 2026-08-03-13:55:
 * resolveFailedPreMergeWorkflowStepBudget peeled from TaskExecutor (U4).
 */
import type { Task, TaskStore, WorkflowStepResult as CoreWorkflowStepResult } from "@fusion/core";
import {
  DEFAULT_MAX_POST_REVIEW_FIXES,
  resolveOptionalReviewRevisionBudget,
  resolveOptionalStepRevisionBudget,
  resolveWorkflowIrForTask,
} from "@fusion/core";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import {
  countOptionalStepRevisionAttempts,
  optionalStepRevisionKey,
} from "./optional-step-revision.js";

export type ResolveFailedPreMergeWorkflowStepBudgetDeps = {
  store: TaskStore;
};

export async function resolveFailedPreMergeWorkflowStepBudget(
  deps: ResolveFailedPreMergeWorkflowStepBudgetDeps,
  task: Task,
  target: CoreWorkflowStepResult,
): Promise<{ unbounded: boolean; max: number; label: string; key: string; stepName?: string; attempts: number }> {
  const settings = await mergeEffectiveSettings(deps.store, task, await deps.store.getSettings());
  const fallback = settings.maxPostReviewFixes ?? DEFAULT_MAX_POST_REVIEW_FIXES;
  let rawMaxRevisions: unknown;
  try {
    const ir = await resolveWorkflowIrForTask(deps.store, task.id);
    if (ir.version === "v2") {
      const node = ir.nodes.find((candidate) => candidate.id === target.workflowStepId && candidate.kind === "optional-group");
      rawMaxRevisions = node?.config?.maxRevisions;
    }
  } catch {
    rawMaxRevisions = undefined;
  }
  const maxRevisions = resolveOptionalReviewRevisionBudget({
    optionalGroupId: target.workflowStepId ?? "",
    workflowSettings: settings as Record<string, unknown>,
    nodeMaxRevisions: rawMaxRevisions,
    fallbackMaxRevisions: fallback,
  });
  const budget = resolveOptionalStepRevisionBudget(maxRevisions, fallback);
  const key = optionalStepRevisionKey(target.workflowStepId, target.workflowStepName);
  return {
    ...budget,
    key,
    stepName: target.workflowStepName,
    attempts: countOptionalStepRevisionAttempts(task, key, target.workflowStepName),
    label: budget.unbounded ? "unbounded" : String(budget.max),
  };
}
