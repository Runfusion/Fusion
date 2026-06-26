import type { Agent, AgentLogEntry, ResolvedModelSelection, Settings, Task, TaskDetail } from "@fusion/core";
import { resolveTaskExecutionModel, resolveTaskPlanningModel, resolveTaskValidatorModel } from "@fusion/core";

export type ModelSelection = ResolvedModelSelection;

export const ACTIVE_STATUSES = new Set(["planning", "researching", "executing", "finalizing", "merging", "merging-fix"]);

const STRING_OBJECT_TAG = "[object String]";

function isStringValue(value: unknown): value is string {
  return Object.prototype.toString.call(value) === STRING_OBJECT_TAG;
}

/*
FNXC:ModelResolution 2026-06-25-00:00:
FN-7040 requires the Chat tab, Agent Log header, and Workflow tab Model settings to share one effective model resolver so runtime log markers, active assigned-agent runtime models, task overrides, and settings fallbacks never diverge between task-detail surfaces.
*/
export function extractExecutorModelFromLog(entries: AgentLogEntry[]): { provider: string; modelId: string } | null {
  let result: { provider: string; modelId: string } | null = null;
  entries.forEach((entry) => {
    if (entry.agent !== "executor" || entry.type !== "text") return;
    const match = entry.text.match(/^Executor using model: (.+?)\/(.+)$/);
    if (match) {
      result = { provider: match[1], modelId: match[2] };
    }
  });
  return result;
}

export function extractReviewerModelFromLog(entries: AgentLogEntry[]): { provider: string; modelId: string } | null {
  let result: { provider: string; modelId: string } | null = null;
  entries.forEach((entry) => {
    if (entry.agent !== "reviewer" || entry.type !== "text") return;
    const match = entry.text.match(/^Reviewer using model: (.+?)\/(.+)$/);
    if (match) {
      result = { provider: match[1], modelId: match[2] };
    }
  });
  return result;
}

export function extractAssignedRuntimeModel(agent: Agent | null | undefined): ModelSelection {
  const runtimeConfig = (agent?.runtimeConfig ?? undefined) as Record<string, unknown> | undefined;
  const model = isStringValue(runtimeConfig?.model) ? runtimeConfig.model.trim() : "";
  if (model) {
    const slashIdx = model.indexOf("/");
    if (slashIdx > 0 && slashIdx < model.length - 1) {
      return {
        provider: model.slice(0, slashIdx),
        modelId: model.slice(slashIdx + 1),
      };
    }
  }

  const provider = isStringValue(runtimeConfig?.modelProvider) ? runtimeConfig.modelProvider.trim() : "";
  const modelId = isStringValue(runtimeConfig?.modelId) ? runtimeConfig.modelId.trim() : "";
  return {
    provider: provider || undefined,
    modelId: modelId || undefined,
  };
}

/**
 * Resolve the effective executor model following the dashboard display resolution order:
 * 1. Runtime executor model from agent log marker
 * 2. Assigned agent runtime model (active runs only)
 * 3. Per-task modelProvider/modelId override
 * 4. Project/global execution lane fallback
 */
export function resolveEffectiveExecutor(
  task: Task | TaskDetail,
  logEntries: AgentLogEntry[],
  assignedAgent: Agent | null,
  settings?: Settings,
): ModelSelection {
  const fromLog = extractExecutorModelFromLog(logEntries);
  if (fromLog) return fromLog;

  if (ACTIVE_STATUSES.has(task.status ?? "") || task.column === "in-progress") {
    const assignedModel = extractAssignedRuntimeModel(assignedAgent);
    if (assignedModel.provider && assignedModel.modelId) {
      return assignedModel;
    }
  }

  return resolveTaskExecutionModel(task, settings);
}

/**
 * Resolve the effective validator model following the dashboard display resolution order.
 * Merger display intentionally reuses this reviewer/validator lane in TaskDetailModal.
 */
export function resolveEffectiveValidator(
  task: Task | TaskDetail,
  logEntries: AgentLogEntry[],
  assignedAgent: Agent | null,
  settings?: Settings,
): ModelSelection {
  const fromLog = extractReviewerModelFromLog(logEntries);
  if (fromLog) return fromLog;

  if (ACTIVE_STATUSES.has(task.status ?? "") || task.column === "in-progress") {
    const assignedModel = extractAssignedRuntimeModel(assignedAgent);
    if (assignedModel.provider && assignedModel.modelId) {
      return assignedModel;
    }
  }

  return resolveTaskValidatorModel(task, settings);
}

/**
 * Extract planning model from agent log entries.
 * Looks for text entries with agent role "triage" matching the pattern:
 *   "Triage using model: <provider>/<modelId>"
 * Returns the latest match, or null if none found.
 */
export function extractPlanningModelFromLog(entries: AgentLogEntry[]): { provider: string; modelId: string } | null {
  let result: { provider: string; modelId: string } | null = null;
  entries.forEach((entry) => {
    if (entry.agent !== "triage" || entry.type !== "text") return;
    const match = entry.text.match(/^Triage using model: (.+?)\/(.+)$/);
    if (match) {
      result = { provider: match[1], modelId: match[2] };
    }
  });
  return result;
}

/**
 * Resolve the effective planning model following the preserved dashboard order:
 * 1. Per-task planningModelProvider/planningModelId override
 * 2. Runtime triage model from agent log marker
 * 3. Project/global planning lane fallback
 */
export function resolveEffectivePlanning(
  task: Task | TaskDetail,
  logEntries: AgentLogEntry[],
  settings?: Settings,
): ModelSelection {
  if (task.planningModelProvider && task.planningModelId) {
    return { provider: task.planningModelProvider, modelId: task.planningModelId };
  }
  const fromLog = extractPlanningModelFromLog(logEntries);
  if (fromLog) {
    return fromLog;
  }
  return resolveTaskPlanningModel(task, settings);
}
