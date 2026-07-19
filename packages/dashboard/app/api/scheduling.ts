/**
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Automations and routines client API peeled from legacy.ts.
 */
import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskUpdateInput,
  AutomationRunResult,
  Routine,
  RoutineCreateInput,
  RoutineUpdateInput,
  RoutineExecutionResult,
  ActivityEventType,
  ActivityLogEntry,
  WorkflowStep,
  WorkflowStepResult,
} from "@fusion/core";
import { api } from "./client.js";
import { withProjectId } from "./health.js";
import { createResilientEventSource } from "./event-source.js";
import type { StreamConnectionState } from "./event-source.js";

// ── Automation / Scheduled Tasks ──────────────────────────────────

/**
 * Options for scheduling scope (global vs project-scoped automations/routines).
 * When scope is "project", projectId must be provided.
 */
export type SchedulingScopeOptions = {
  /** Scope for scheduling operations: "global" or "project". Defaults to "project" on the server. */
  scope?: "global" | "project";
  /** Project ID required when scope is "project". */
  projectId?: string;
};

/**
 * Build URL suffix with scope and projectId query params.
 * Mirrors the backend's parseScopeParam logic: scope goes in query param.
 */
function withSchedulingScope(path: string, options?: SchedulingScopeOptions): string {
  const params = new URLSearchParams();
  if (options?.scope) {
    params.set("scope", options.scope);
  }
  if (options?.projectId) {
    params.set("projectId", options.projectId);
  }
  const suffix = params.toString();
  if (!suffix) return path;
  return `${path}?${suffix}`;
}

/** Response from the manual run trigger endpoint. */
export interface AutomationRunResponse {
  schedule: ScheduledTask;
  result: AutomationRunResult;
}

export function fetchAutomations(options?: SchedulingScopeOptions): Promise<ScheduledTask[]> {
  return api<ScheduledTask[]>(withSchedulingScope("/automations", options));
}

export function fetchAutomation(id: string, options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  return api<ScheduledTask>(withSchedulingScope(`/automations/${id}`, options));
}

export function createAutomation(input: ScheduledTaskCreateInput, options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  // Forward all input fields including scope metadata (scope may be set on input or in options)
  return api<ScheduledTask>(withSchedulingScope("/automations", options), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateAutomation(id: string, updates: ScheduledTaskUpdateInput, options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  // Forward all update fields including scope metadata
  return api<ScheduledTask>(withSchedulingScope(`/automations/${id}`, options), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteAutomation(id: string, options?: SchedulingScopeOptions): Promise<void> {
  await api(withSchedulingScope(`/automations/${id}`, options), {
    method: "DELETE",
  });
}

export function runAutomation(id: string, options?: SchedulingScopeOptions): Promise<AutomationRunResponse> {
  return api<AutomationRunResponse>(withSchedulingScope(`/automations/${id}/run`, options), {
    method: "POST",
  });
}

export function toggleAutomation(id: string, options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  return api<ScheduledTask>(withSchedulingScope(`/automations/${id}/toggle`, options), {
    method: "POST",
  });
}

export function reorderAutomationSteps(id: string, stepIds: string[], options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  return api<ScheduledTask>(withSchedulingScope(`/automations/${id}/steps/reorder`, options), {
    method: "POST",
    body: JSON.stringify({ stepIds }),
  });
}

// ── Routines API ────────────────────────────────────────────────

export interface RoutineRunResponse {
  routine: Routine;
  result: RoutineExecutionResult;
  liveRunId?: string;
}

export type RoutineRunStreamEvent =
  | { type: "run"; runId?: string; scheduleId?: string; status?: string }
  | { type: "step"; runId?: string; stepIndex?: number; stepId?: string; stepName?: string; stepType?: string; status?: string; success?: boolean; error?: string }
  | { type: "output"; runId?: string; text?: string }
  | { type: "tool"; runId?: string; status?: string; name?: string; args?: unknown; isError?: boolean; result?: unknown }
  | { type: "complete"; runId?: string; result?: RoutineExecutionResult }
  | { type: "error"; runId?: string; message?: string; result?: RoutineExecutionResult };

export interface RoutineRunStreamHandlers {
  onEvent: (event: RoutineRunStreamEvent) => void;
  onConnectionStateChange?: (state: StreamConnectionState) => void;
  onFatalError?: (message: string) => void;
}

export function fetchRoutines(options?: SchedulingScopeOptions): Promise<Routine[]> {
  return api<Routine[]>(withSchedulingScope("/routines", options));
}

export function fetchRoutine(id: string, options?: SchedulingScopeOptions): Promise<Routine> {
  return api<Routine>(withSchedulingScope(`/routines/${id}`, options));
}

export function createRoutine(input: RoutineCreateInput, options?: SchedulingScopeOptions): Promise<Routine> {
  // Forward all input fields including scope metadata
  return api<Routine>(withSchedulingScope("/routines", options), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateRoutine(id: string, updates: RoutineUpdateInput, options?: SchedulingScopeOptions): Promise<Routine> {
  // Forward all update fields including scope metadata
  return api<Routine>(withSchedulingScope(`/routines/${id}`, options), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteRoutine(id: string, options?: SchedulingScopeOptions): Promise<void> {
  await api(withSchedulingScope(`/routines/${id}`, options), {
    method: "DELETE",
  });
}

export function runRoutine(id: string, options?: SchedulingScopeOptions): Promise<RoutineRunResponse> {
  return api<RoutineRunResponse>(withSchedulingScope(`/routines/${id}/trigger`, options), {
    method: "POST",
  });
}

export function streamRoutineRun(id: string, handlers: RoutineRunStreamHandlers, options?: SchedulingScopeOptions & { runId?: string }) {
  const baseUrl = withSchedulingScope(`/routines/${id}/run/stream`, options);
  const separator = baseUrl.includes("?") ? "&" : "?";
  const url = options?.runId ? `${baseUrl}${separator}runId=${encodeURIComponent(options.runId)}` : baseUrl;
  const parse = (type: RoutineRunStreamEvent["type"], event: MessageEvent) => {
    let data: Record<string, unknown> = {};
    try {
      data = event.data ? JSON.parse(event.data) : {};
    } catch {
      data = { message: event.data };
    }
    handlers.onEvent({ type, ...data } as RoutineRunStreamEvent);
  };
  return createResilientEventSource(
    url,
    {
      events: {
        run: (event) => parse("run", event),
        step: (event) => parse("step", event),
        output: (event) => parse("output", event),
        tool: (event) => parse("tool", event),
        complete: (event) => parse("complete", event),
        error: (event) => parse("error", event),
      },
    },
    {
      maxReconnectAttempts: 2,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: handlers.onFatalError,
    },
  );
}

export function fetchRoutineRuns(id: string, options?: SchedulingScopeOptions): Promise<RoutineExecutionResult[]> {
  return api<RoutineExecutionResult[]>(withSchedulingScope(`/routines/${id}/runs`, options));
}

export function triggerRoutineWebhook(id: string, payload?: Record<string, unknown>, options?: SchedulingScopeOptions): Promise<RoutineRunResponse> {
  return api<RoutineRunResponse>(withSchedulingScope(`/routines/${id}/webhook`, options), {
    method: "POST",
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

// ── Activity Log API ────────────────────────────────────────────

/** Re-export ActivityLogEntry type from core for convenience */
export type { ActivityLogEntry, ActivityEventType } from "@fusion/core";

/** Fetch activity log entries */
export function fetchActivityLog(options?: { limit?: number; since?: string; type?: ActivityEventType; projectId?: string }): Promise<ActivityLogEntry[]> {
  const search = new URLSearchParams();
  if (options?.limit !== undefined) search.set("limit", String(options.limit));
  if (options?.since !== undefined) search.set("since", options.since);
  if (options?.type !== undefined) search.set("type", options.type);
  if (options?.projectId) search.set("projectId", options.projectId);
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return api<ActivityLogEntry[]>(`/activity${suffix}`);
}

/** Clear all activity log entries */
export function clearActivityLog(projectId?: string): Promise<{ success: boolean }> {
  const path = withProjectId("/activity", projectId);
  return api<{ success: boolean }>(path, { method: "DELETE" });
}

// ── Workflow Steps ─────────────────────────────────────────────────────

/*
FNXC:WorkflowStepCRUD 2026-06-25-00:00:
U5 removed the legacy `/workflow-steps` CRUD/REST surface (GET list, POST create,
PATCH update, DELETE, refine) along with its Settings management UI. The client
mutation helpers (`createWorkflowStep`/`updateWorkflowStep`/`deleteWorkflowStep`/
`refineWorkflowStepPrompt`/`createWorkflowStepFromTemplate`) had no remaining callers
and were deleted. `fetchWorkflowSteps` is retained as a stable, no-network shim
returning `[]`: its only remaining consumers are the plugin dashboard context's
`workflowSteps` field and the WorkflowResultsTab option list, both of which now source
step state from the graph (optional-group nodes) — the legacy definition list no longer
exists. Removing the field outright is graph-native U3 plumbing work, out of scope here.
*/
/** Legacy workflow-step definition list (removed in U5). Resolves to an empty list:
 *  built-in/custom step definitions are now graph optional-group nodes, not DB rows. */
export function fetchWorkflowSteps(_projectId?: string): Promise<WorkflowStep[]> {
  return Promise.resolve([]);
}

/** Fetch workflow step results for a task */
export function fetchWorkflowResults(taskId: string, projectId?: string): Promise<WorkflowStepResult[]> {
  return api<WorkflowStepResult[]>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/workflow-results`, projectId));
}

