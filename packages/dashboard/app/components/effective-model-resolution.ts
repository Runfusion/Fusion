import type { Agent, AgentLogEntry, ResolvedModelSelection, Settings, Task, TaskDetail } from "@fusion/core";
import { isWipColumnRole } from "../utils/columnRoles";
// FNXC:WorkflowLifecycleColumns 2026-07-30-11:50: these are AGENT ROLE comparisons, not
// column guards — the planner LANE keeps the name `triage`; U11 removed only the COLUMN.
import { PLANNER_AGENT_ROLE, resolveTaskExecutionModel, resolveTaskPlanningModel, resolveTaskValidatorModel } from "@fusion/core";
import { ACTIVE_STATUSES } from "../utils/taskActivity";

export type ModelSelection = ResolvedModelSelection;
export { ACTIVE_STATUSES };

const STRING_OBJECT_TAG = "[object String]";

function isStringValue(value: unknown): value is string {
  return Object.prototype.toString.call(value) === STRING_OBJECT_TAG;
}

/*
FNXC:ModelResolution 2026-06-25-00:00:
FN-7040 requires the Chat tab, Agent Log header, and Workflow tab Model settings to share one effective model resolver so runtime log markers, active assigned-agent runtime models, task overrides, and settings fallbacks never diverge between task-detail surfaces.

FNXC:TaskLogModelThinking 2026-07-01-00:00:
Runtime "using model" markers may append parenthesized diagnostics such as thinking effort, workflow-step overrides, or fallback reasons. Dashboard model resolution strips those suffix annotations while preserving legacy exact markers so provider icons and effective-model headers continue to resolve from the same row operators read in Activity and Raw Logs.

FNXC:PlanningModelMarker 2026-07-21-12:00:
New planning sessions identify the operator-facing lane as Planning, while historical rows retain Triage. Treat both prefixes as one planning lane so stored logs continue to resolve provider icons and effective-model headers.
*/
const MODEL_MARKER_PATTERN = /^(Planning|Triage|Executor|Reviewer) using model: ([^/\s]+)\/(.+?)(?:\s+\([^)]*\))*$/;

/*
FNXC:TaskLogModelThinking 2026-07-15-11:20:
Engine lanes now write standalone messages (including the "using model" markers) as `status` rather than `text`, so complete messages are never glued together like streamed deltas. Model resolution must accept BOTH: `status` for markers written after that change, `text` for the rows already persisted in every existing task's log. Dropping `text` here would silently blank the provider icons and effective-model headers on historical tasks.
*/
function isEngineMarkerEntryType(type: AgentLogEntry["type"]): boolean {
  return type === "status" || type === "text";
}

export function parseRuntimeModelMarker(text: string, role: "Planning" | "Triage" | "Executor" | "Reviewer"): { provider: string; modelId: string } | null {
  const match = text.match(MODEL_MARKER_PATTERN);
  const isPlanningRole = role === "Planning" || role === "Triage";
  const matchesRole = isPlanningRole
    ? match?.[1] === "Planning" || match?.[1] === "Triage"
    : match?.[1] === role;
  if (!match || !matchesRole) return null;
  return { provider: match[2], modelId: match[3] };
}

export function extractExecutorModelFromLog(entries: AgentLogEntry[]): { provider: string; modelId: string } | null {
  let result: { provider: string; modelId: string } | null = null;
  entries.forEach((entry) => {
    if (entry.agent !== "executor" || !isEngineMarkerEntryType(entry.type)) return;
    const match = parseRuntimeModelMarker(entry.text, "Executor");
    if (match) {
      result = match;
    }
  });
  return result;
}

export function extractReviewerModelFromLog(entries: AgentLogEntry[]): { provider: string; modelId: string } | null {
  let result: { provider: string; modelId: string } | null = null;
  entries.forEach((entry) => {
    if (entry.agent !== "reviewer" || !isEngineMarkerEntryType(entry.type)) return;
    const match = parseRuntimeModelMarker(entry.text, "Reviewer");
    if (match) {
      result = match;
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
  const credentialInstanceId = isStringValue(runtimeConfig?.credentialInstanceId) ? runtimeConfig.credentialInstanceId.trim() : "";
  return {
    provider: provider || undefined,
    modelId: modelId || undefined,
    ...(credentialInstanceId ? { credentialInstanceId } : {}),
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
  columnFlags?: Parameters<typeof isWipColumnRole>[0],
): ModelSelection {
  const fromLog = extractExecutorModelFromLog(logEntries);
  if (fromLog) return fromLog;

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:30 (batch-dashboard-app):
  WIP role, resolved; `columnFlags` omitted -> the legacy id.

  This decides whether the ASSIGNED AGENT's runtime model is the effective one — true only while the
  card is actually being worked. Keyed on the literal, a card executing in a renamed wip lane fell
  through to the configured default, so the dashboard displayed a different model than the one the
  running agent was using. Wrong in the quietest possible way: a plausible model name, for the whole
  duration of the run.
  */
  if (ACTIVE_STATUSES.has(task.status ?? "") || isWipColumnRole(columnFlags, task.column)) {
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
  columnFlags?: Parameters<typeof isWipColumnRole>[0],
): ModelSelection {
  const fromLog = extractReviewerModelFromLog(logEntries);
  if (fromLog) return fromLog;

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:30 (batch-dashboard-app):
  WIP role, resolved; `columnFlags` omitted -> the legacy id.

  This decides whether the ASSIGNED AGENT's runtime model is the effective one — true only while the
  card is actually being worked. Keyed on the literal, a card executing in a renamed wip lane fell
  through to the configured default, so the dashboard displayed a different model than the one the
  running agent was using. Wrong in the quietest possible way: a plausible model name, for the whole
  duration of the run.
  */
  if (ACTIVE_STATUSES.has(task.status ?? "") || isWipColumnRole(columnFlags, task.column)) {
    const assignedModel = extractAssignedRuntimeModel(assignedAgent);
    if (assignedModel.provider && assignedModel.modelId) {
      return assignedModel;
    }
  }

  return resolveTaskValidatorModel(task, settings);
}

/**
 * Extract planning model from agent log entries.
 * Looks for status or text entries with agent role "triage" matching either pattern:
 *   "Planning using model: <provider>/<modelId>"
 *   "Triage using model: <provider>/<modelId>" (legacy)
 * Returns the latest match, or null if none found.
 */
export function extractPlanningModelFromLog(entries: AgentLogEntry[]): { provider: string; modelId: string } | null {
  let result: { provider: string; modelId: string } | null = null;
  entries.forEach((entry) => {
    if (entry.agent !== PLANNER_AGENT_ROLE || !isEngineMarkerEntryType(entry.type)) return;
    const match = parseRuntimeModelMarker(entry.text, "Planning");
    if (match) {
      result = match;
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
    return {
      provider: task.planningModelProvider,
      modelId: task.planningModelId,
      ...(task.planningCredentialInstanceId ? { credentialInstanceId: task.planningCredentialInstanceId } : {}),
    };
  }
  const fromLog = extractPlanningModelFromLog(logEntries);
  if (fromLog) {
    return fromLog;
  }
  return resolveTaskPlanningModel(task, settings);
}
