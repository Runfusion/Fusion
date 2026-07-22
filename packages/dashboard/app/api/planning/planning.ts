/**
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Planning mode and agent onboarding client API peeled from legacy.ts.
 */

import type {
  PlanningQuestion,
  PlanningSummary,
} from "@fusion/core";
import type { SubtaskItem, PlanningSubtaskDraft } from "./ai-text.js";
import type { AgentCapability } from "@fusion/core";
import type { Task } from "@fusion/core";
import { api, buildApiUrl } from "../client/client.js";
import { withProjectId } from "../client/health.js";
import { createResilientEventSource } from "../client/event-source.js";
import type { StreamConnectionState } from "../client/event-source.js";
import { startKeepAlive } from "./ai-sessions.js";

// --- Planning Mode API ---

/** Planning session state returned from API */
export interface PlanningSession {
  sessionId: string;
  currentQuestion: PlanningQuestion | null;
  summary: PlanningSummary | null;
}

/** The response endpoint may synchronously return a generated next question before SSE delivers it. */
export type PlanningResponse = PlanningSession | { type: "question"; data: PlanningQuestion };

/** SSE event types for planning session streaming */
export type PlanningStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "question"; data: PlanningQuestion }
  | { type: "summary"; data: PlanningSummary }
  | { type: "error"; data: string }
  | { type: "complete"; data: Record<string, never> };

export interface AgentOnboardingSummary {
  name: string;
  role: AgentCapability | "custom";
  instructionsText: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  maxTurns: number;
  title?: string;
  icon?: string;
  reportsTo?: string;
  soul?: string;
  memory?: string;
  skills?: string[];
  templateId?: string;
  patternAgentId?: string;
  rationale?: string;
  model?: string;
  /** Draft-only AI suggestion for eventual runtimeConfig.model selection. */
  modelHint?: string;
  /** Draft-only AI suggestion for eventual runtimeConfig.runtimeHint plugin runtime selection. */
  runtimeHint?: string;
  heartbeatProcedurePath?: string;
  heartbeatIntervalMs?: number;
  heartbeatEnabled?: boolean;
}

export type OnboardingMode = "create" | "edit";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ExistingAgentOnboardingConfig {
  name?: string;
  role?: AgentCapability | "custom";
  title?: string;
  instructionsText?: string;
  soul?: string;
  memory?: string;
  reportsTo?: string;
  skills?: string[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  runtimeHint?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxConcurrentRuns?: number;
  messageResponseMode?: "immediate" | "on-heartbeat";
}

export type AgentOnboardingStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "question"; data: PlanningQuestion }
  | { type: "summary"; data: AgentOnboardingSummary }
  | { type: "error"; data: string }
  | { type: "complete"; data: Record<string, never> };

/** Start a new planning session with an initial plan */
export function startPlanning(
  initialPlan: string,
  projectId?: string,

): Promise<PlanningSession> {
  return api<PlanningSession>(withProjectId("/planning/start", projectId), {
    method: "POST",
    body: JSON.stringify({
      initialPlan,
    }),
  });
}

export function createPlanningDraft(
  initialPlan: string,
  projectId?: string,
  modelOverride?: { planningModelProvider?: string; planningModelId?: string; thinkingLevel?: ThinkingLevel },
): Promise<{ sessionId: string; title: string }> {
  return api<{ sessionId: string; title: string }>(withProjectId("/planning/create-draft", projectId), {
    method: "POST",
    body: JSON.stringify({
      initialPlan,
      planningModelProvider: modelOverride?.planningModelProvider,
      planningModelId: modelOverride?.planningModelId,
      thinkingLevel: modelOverride?.thinkingLevel,
    }),
  });
}

/** Start a new planning session with AI streaming support */
export function startPlanningStreaming(
  initialPlan: string,
  projectId?: string,
  modelOverride?: { planningModelProvider?: string; planningModelId?: string; thinkingLevel?: ThinkingLevel },
  planningOptions?: { clarificationEnabled?: boolean; workflowId?: string | null },
  existingSessionId?: string,
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/planning/start-streaming", projectId), {
    method: "POST",
    body: JSON.stringify({
      initialPlan,
      planningModelProvider: modelOverride?.planningModelProvider,
      planningModelId: modelOverride?.planningModelId,
      thinkingLevel: modelOverride?.thinkingLevel,
      clarificationEnabled: planningOptions?.clarificationEnabled,
      ...(planningOptions?.workflowId ? { workflowId: planningOptions.workflowId } : {}),
      ...(existingSessionId ? { existingSessionId } : {}),
    }),
  });
}

/** Explicitly validate the current running planning summary before creating work. */
export function validatePlanningSession(sessionId: string, projectId?: string): Promise<{ summary: PlanningSummary; validated: boolean }> {
  return api<{ summary: PlanningSummary; validated: boolean }>(withProjectId(`/planning/${encodeURIComponent(sessionId)}/validate`, projectId), { method: "POST" });
}

/** Rename a planning session after the server verifies the session type. */
export function updatePlanningSessionTitle(sessionId: string, title: string, projectId?: string): Promise<{ sessionId: string; title: string }> {
  return api<{ sessionId: string; title: string }>(withProjectId(`/planning/${encodeURIComponent(sessionId)}/title`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

/** Submit a response to the current planning question */
export function respondToPlanning(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
): Promise<PlanningResponse> {
  return api<PlanningResponse>(withProjectId("/planning/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

/** Rewind a planning session to the previous answered question */
export function rewindPlanningSession(
  sessionId: string,
  projectId?: string,
  questionId?: string,
): Promise<{ currentQuestion: PlanningQuestion; summary?: PlanningSummary; history: Array<{ question: PlanningQuestion; response: unknown; thinkingOutput?: string }> }> {
  return api<{ currentQuestion: PlanningQuestion; summary?: PlanningSummary; history: Array<{ question: PlanningQuestion; response: unknown; thinkingOutput?: string }> }>(
    withProjectId(`/planning/${encodeURIComponent(sessionId)}/back`, projectId),
    {
      method: "POST",
      ...(questionId ? { body: JSON.stringify({ questionId }) } : {}),
    },
  );
}

/** Retry a failed planning session turn */
export function retryPlanningSession(
  sessionId: string,
  projectId?: string,
): Promise<{ success: boolean; sessionId: string }> {
  return api<{ success: boolean; sessionId: string }>(
    withProjectId(`/planning/${encodeURIComponent(sessionId)}/retry`, projectId),
    {
      method: "POST",
    },
  );
}

/** Stop in-flight planning generation for a session */
export function stopPlanningGeneration(
  sessionId: string,
  projectId?: string,
): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(
    withProjectId(`/planning/${encodeURIComponent(sessionId)}/stop`, projectId),
    {
      method: "POST",
    },
  );
}

/** Cancel an active planning session */
export function cancelPlanning(sessionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId("/planning/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

export function startAgentOnboardingStreaming(
  intent: string,
  context: {
    existingAgents: Array<{ id: string; name: string; role: string }>;
    templates: Array<{ id: string; label: string; description?: string }>;
    mode?: OnboardingMode;
    existingAgentConfig?: ExistingAgentOnboardingConfig;
  },
  projectId?: string,
  modelOverride?: { planningModelProvider?: string; planningModelId?: string },
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/agents/onboarding/start-streaming", projectId), {
    method: "POST",
    body: JSON.stringify({
      intent,
      context,
      mode: context.mode,
      existingAgentConfig: context.existingAgentConfig,
      planningModelProvider: modelOverride?.planningModelProvider,
      planningModelId: modelOverride?.planningModelId,
    }),
  });
}

export function respondToAgentOnboarding(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
): Promise<{ type: "question" | "complete"; data: PlanningQuestion | AgentOnboardingSummary }> {
  return api(withProjectId("/agents/onboarding/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

export function retryAgentOnboardingSession(sessionId: string, projectId?: string): Promise<{ success: boolean; sessionId: string }> {
  return api(withProjectId(`/agents/onboarding/${encodeURIComponent(sessionId)}/retry`, projectId), {
    method: "POST",
  });
}

export function stopAgentOnboardingGeneration(sessionId: string, projectId?: string): Promise<{ success: boolean }> {
  return api(withProjectId(`/agents/onboarding/${encodeURIComponent(sessionId)}/stop`, projectId), {
    method: "POST",
  });
}

export function cancelAgentOnboarding(sessionId: string, projectId?: string): Promise<void> {
  return api(withProjectId("/agents/onboarding/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

/** Create a task from a completed planning session */
export function createTaskFromPlanning(
  sessionId: string,
  summary?: PlanningSummary,
  projectId?: string,
  options?: {
    branch?: string;
    baseBranch?: string;
    branchSelection?: {
      mode: "project-default" | "auto-new" | "existing" | "custom-new";
      branchName?: string;
      baseBranch?: string;
    };
    workflowId?: string | null;
  },
): Promise<Task> {
  return api<{ task: Task; alreadyCreated: boolean }>(withProjectId("/planning/create-task", projectId), {
    method: "POST",
    body: JSON.stringify({
      ...(summary ? { sessionId, summary } : { sessionId }),
      ...(options?.branch !== undefined ? { branch: options.branch } : {}),
      ...(options?.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
      ...(options?.branchSelection ? { branchSelection: options.branchSelection } : {}),
      ...(options?.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
    }),
  }).then((response) => response.task);
}

/** Start subtask breakdown from a completed planning session */
export function startPlanningBreakdown(
  sessionId: string,
  summary?: PlanningSummary,
  projectId?: string,
): Promise<{ sessionId: string; subtasks: SubtaskItem[] }> {
  return api<{ sessionId: string; subtasks: SubtaskItem[] }>(
    withProjectId("/planning/start-breakdown", projectId),
    {
      method: "POST",
      body: JSON.stringify(summary ? { sessionId, summary } : { sessionId }),
    },
  );
}

/** Create multiple tasks from a completed planning session */
export function createTasksFromPlanning(
  planningSessionId: string,
  subtasks: PlanningSubtaskDraft[],
  projectId?: string,
  options?: {
    branchSelection?: {
      mode: "project-default" | "auto-new" | "existing" | "custom-new";
      branchName?: string;
      baseBranch?: string;
    };
    branchAssignment?: {
      mode: "shared" | "per-task-derived";
    };
    workflowId?: string | null;
  },
): Promise<{ tasks: Task[] }> {
  return api<{ tasks: Task[] }>(withProjectId("/planning/create-tasks", projectId), {
    method: "POST",
    body: JSON.stringify({
      planningSessionId,
      subtasks,
      ...(options?.branchSelection ? { branchSelection: options.branchSelection } : {}),
      ...(options?.branchAssignment ? { branchAssignment: options.branchAssignment } : {}),
      ...(options?.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
    }),
  });
}



export function getPlanningStreamUrl(sessionId: string, projectId?: string): string {
  return buildApiUrl(withProjectId(`/planning/${encodeURIComponent(sessionId)}/stream`, projectId));
}

export function getAgentOnboardingStreamUrl(sessionId: string, projectId?: string): string {
  return buildApiUrl(withProjectId(`/agents/onboarding/${encodeURIComponent(sessionId)}/stream`, projectId));
}

export function connectAgentOnboardingStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: AgentOnboardingSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = getAgentOnboardingStreamUrl(sessionId, projectId);
  const resilient = createResilientEventSource(
    url,
    {
      events: {
        thinking: (event) => {
          try { handlers.onThinking?.(JSON.parse(event.data)); } catch { handlers.onThinking?.(event.data); }
        },
        question: (event) => {
          try { handlers.onQuestion?.(JSON.parse(event.data) as PlanningQuestion); } catch { /* ignore parse error */ }
        },
        summary: (event) => {
          try { handlers.onSummary?.(JSON.parse(event.data) as AgentOnboardingSummary); } catch { /* ignore parse error */ }
        },
        error: (event) => {
          try {
            const parsed = JSON.parse(event.data);
            handlers.onError?.(parsed.message || parsed);
          } catch {
            handlers.onError?.(event.data || "Stream error");
          }
        },
        complete: () => {
          handlers.onComplete?.();
        },
      },
    },
    {
      maxReconnectAttempts: options?.maxReconnectAttempts,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: (message) => handlers.onError?.(message),
    },
  );

  return {
    close: resilient.close,
    isConnected: resilient.isConnected,
  };
}

/** Connect to planning session SSE stream and handle events
 * 
 * Returns an object with:
 * - close: function to close the connection
 */
export function connectPlanningStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: PlanningSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = getPlanningStreamUrl(sessionId, projectId);
  let keepAlive: { stop: () => void } | null = null;
  let connection: { close: () => void; isConnected: () => boolean } | null = null;

  const stopKeepAlive = () => {
    keepAlive?.stop();
    keepAlive = null;
  };

  const resilient = createResilientEventSource(
    url,
    {
      onOpen: () => {
        stopKeepAlive();
        keepAlive = startKeepAlive(sessionId, projectId);
      },
      onMessage: (event) => {
        if (event.data.startsWith(":")) return;
      },
      events: {
        thinking: (event) => {
          try {
            handlers.onThinking?.(JSON.parse(event.data));
          } catch {
            handlers.onThinking?.(event.data);
          }
        },
        question: (event) => {
          try {
            handlers.onQuestion?.(JSON.parse(event.data) as PlanningQuestion);
          } catch (err) {
            console.error("[planning] Failed to parse question event:", err);
          }
        },
        summary: (event) => {
          try {
            handlers.onSummary?.(JSON.parse(event.data) as PlanningSummary);
          } catch (err) {
            console.error("[planning] Failed to parse summary event:", err);
          }
        },
        error: (event) => {
          try {
            const parsed = JSON.parse(event.data);
            handlers.onError?.(parsed.message || parsed);
          } catch {
            handlers.onError?.(event.data || "Stream error");
          }
          connection?.close();
        },
        complete: () => {
          handlers.onComplete?.();
          connection?.close();
        },
      },
    },
    {
      maxReconnectAttempts: options?.maxReconnectAttempts,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: (message) => {
        stopKeepAlive();
        handlers.onError?.(message);
      },
    },
  );

  connection = {
    close: () => {
      stopKeepAlive();
      resilient.close();
    },
    isConnected: resilient.isConnected,
  };

  return connection;
}

