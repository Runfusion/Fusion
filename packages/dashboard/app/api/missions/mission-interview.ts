/**
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Mission / milestone / slice interview streaming client API peeled from legacy.ts.
 */

import type { PlanningQuestion } from "@fusion/core";
import type { MissionInterviewDraftSummary } from "../../components/mission-types";
import type { Milestone, MissionWithHierarchy, Slice } from "./missions.js";
import type { ThinkingLevel } from "../planning/planning.js";
import { api, buildApiUrl } from "../client/client.js";
import { withProjectId } from "../client/health.js";
import { createResilientEventSource } from "../client/event-source.js";
import type { StreamConnectionState } from "../client/event-source.js";
import { startKeepAlive } from "../planning/ai-sessions.js";

// ── Mission Interview API ─────────────────────────────────────────────────

/** Mission plan types returned by the interview AI */
export interface MissionPlanFeature {
  title: string;
  description?: string;
  acceptanceCriteria?: string;
}

export interface MissionPlanSlice {
  title: string;
  description?: string;
  verification?: string;
  features: MissionPlanFeature[];
}

export interface MissionPlanMilestone {
  title: string;
  description?: string;
  verification?: string;
  slices: MissionPlanSlice[];
}

export interface MissionPlanSummary {
  missionTitle?: string;
  missionDescription?: string;
  milestones: MissionPlanMilestone[];
}

export type MissionInterviewResponse =
  | { type: "question"; data: PlanningQuestion }
  | { type: "complete"; data: MissionPlanSummary };

/** Start a mission interview session with AI streaming */
export function startMissionInterview(
  missionTitle: string,
  projectId?: string,
  modelOverride?: { modelProvider?: string; modelId?: string; thinkingLevel?: ThinkingLevel },
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/missions/interview/start", projectId), {
    method: "POST",
    body: JSON.stringify({
      missionTitle,
      modelProvider: modelOverride?.modelProvider,
      modelId: modelOverride?.modelId,
      thinkingLevel: modelOverride?.thinkingLevel,
    }),
  });
}

/** Submit a response to the current interview question */
export function respondToMissionInterview(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
): Promise<MissionInterviewResponse> {
  return api<MissionInterviewResponse>(withProjectId("/missions/interview/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

/** Retry a failed mission interview turn */
export function retryMissionInterviewSession(
  sessionId: string,
  projectId?: string,
): Promise<{ success: boolean; sessionId: string }> {
  return api<{ success: boolean; sessionId: string }>(
    withProjectId(`/missions/interview/${encodeURIComponent(sessionId)}/retry`, projectId),
    { method: "POST" },
  );
}

/** Cancel an active mission interview session */
export function cancelMissionInterview(sessionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId("/missions/interview/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

export async function fetchMissionInterviewDrafts(projectId?: string): Promise<MissionInterviewDraftSummary[]> {
  const query = projectId ? `?${new URLSearchParams({ projectId }).toString()}` : "";
  const result = await api<{ drafts?: MissionInterviewDraftSummary[] }>(`/missions/interview/drafts${query}`);
  return result.drafts ?? [];
}

export function discardMissionInterviewDraft(
  sessionId: string,
  projectId?: string,
): Promise<{ removed: boolean }> {
  return api<{ removed: boolean }>(
    withProjectId(`/missions/interview/drafts/${encodeURIComponent(sessionId)}/discard`, projectId),
    { method: "POST" },
  );
}

/** Create mission from completed interview */
export function createMissionFromInterview(
  sessionId: string,
  summary?: MissionPlanSummary,
  projectId?: string,
  options?: {
    branch?: string;
    baseBranch?: string;
    branchSelection?: {
      mode: "project-default" | "auto-new" | "existing" | "custom-new";
      branchName?: string;
      baseBranch?: string;
    };
    branchAssignment?: { mode: "shared" | "per-task-derived" };
  },
): Promise<MissionWithHierarchy> {
  return api<MissionWithHierarchy>(withProjectId("/missions/interview/create-mission", projectId), {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      summary,
      ...(options?.branch !== undefined ? { branch: options.branch } : {}),
      ...(options?.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
      ...(options?.branchSelection ? { branchSelection: options.branchSelection } : {}),
      ...(options?.branchAssignment ? { branchAssignment: options.branchAssignment } : {}),
    }),
  });
}

const MISSION_INTERVIEW_STREAM_ERROR_MESSAGE = "The mission interview stream was interrupted. Please retry the session.";

function normalizeMissionInterviewStreamError(data: string | undefined): string {
  const raw = data?.trim() ?? "";
  if (!raw) return MISSION_INTERVIEW_STREAM_ERROR_MESSAGE;

  const normalizeMessage = (value: unknown): string => {
    if (typeof value !== "string") return MISSION_INTERVIEW_STREAM_ERROR_MESSAGE;
    const message = value.trim();
    if (!message || message === "Stream error") return MISSION_INTERVIEW_STREAM_ERROR_MESSAGE;
    return message;
  };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const message = (parsed as { message?: unknown; error?: unknown }).message ?? (parsed as { error?: unknown }).error;
      return normalizeMessage(message);
    }
    return normalizeMessage(parsed);
  } catch {
    return normalizeMessage(raw);
  }
}

/** Connect to mission interview SSE stream and handle events */
export function connectMissionInterviewStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: MissionPlanSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(withProjectId(`/missions/interview/${encodeURIComponent(sessionId)}/stream`, projectId));
  let keepAlive: { stop: () => void } | null = null;
  let connection: { close: () => void; isConnected: () => boolean } | null = null;
  let terminalEventHandled = false;

  const stopKeepAlive = () => {
    keepAlive?.stop();
    keepAlive = null;
  };

  const closeTerminalConnection = () => {
    stopKeepAlive();
    connection?.close();
  };

  const notifyTerminalError = (message: string) => {
    if (terminalEventHandled) return;
    terminalEventHandled = true;
    closeTerminalConnection();
    handlers.onError?.(message);
  };

  const notifyTerminalComplete = () => {
    if (terminalEventHandled) return;
    terminalEventHandled = true;
    closeTerminalConnection();
    handlers.onComplete?.();
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
            console.error("[mission-interview] Failed to parse question event:", err);
          }
        },
        summary: (event) => {
          try {
            handlers.onSummary?.(JSON.parse(event.data) as MissionPlanSummary);
          } catch (err) {
            console.error("[mission-interview] Failed to parse summary event:", err);
          }
        },
        error: (event) => {
          /*
          FNXC:MissionInterviewStream 2026-06-24-00:00:
          Mission interview stream failures are terminal for the current EventSource. Normalize malformed/empty/generic payloads, close keepalive + SSE once, and ignore duplicate late error/complete events so the modal can show one recoverable Retry state instead of a stale spinner or raw stream failure.
          */
          notifyTerminalError(normalizeMissionInterviewStreamError(event.data));
        },
        complete: () => {
          notifyTerminalComplete();
        },
      },
    },
    {
      maxReconnectAttempts: options?.maxReconnectAttempts,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: (message) => {
        notifyTerminalError(normalizeMissionInterviewStreamError(message));
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

// ── Milestone/Slice Interview API ─────────────────────────────────────────

/** Summary type for milestone/slice interview responses */
export interface TargetInterviewSummary {
  title?: string;
  description?: string;
  planningNotes?: string;
  verification?: string;
}

/** Response from milestone/slice interview: either a question or a completed plan */
export type TargetInterviewResponse =
  | { type: "question"; data: PlanningQuestion }
  | { type: "complete"; data: TargetInterviewSummary };

// Helper functions for URL construction
function buildMilestoneInterviewUrl(milestoneId: string, path: string, projectId?: string): string {
  return withProjectId(
    `/missions/milestones/${encodeURIComponent(milestoneId)}/interview${path}`,
    projectId
  );
}

function buildSliceInterviewUrl(sliceId: string, path: string, projectId?: string): string {
  return withProjectId(
    `/missions/slices/${encodeURIComponent(sliceId)}/interview${path}`,
    projectId
  );
}

/** Start a milestone interview session */
export function startMilestoneInterview(
  milestoneId: string,
  projectId?: string,
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(buildMilestoneInterviewUrl(milestoneId, "/start", projectId), {
    method: "POST",
  });
}

/** Submit a response to a milestone interview question */
export function respondToMilestoneInterview(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
): Promise<TargetInterviewResponse> {
  return api<TargetInterviewResponse>(buildMilestoneInterviewUrl(sessionId, "/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

/** Connect to milestone interview SSE stream and handle events */
export function connectMilestoneInterviewStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: TargetInterviewSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(buildMilestoneInterviewUrl(sessionId, `/${encodeURIComponent(sessionId)}/stream`, projectId));
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
            console.error("[milestone-interview] Failed to parse question event:", err);
          }
        },
        summary: (event) => {
          try {
            handlers.onSummary?.(JSON.parse(event.data) as TargetInterviewSummary);
          } catch (err) {
            console.error("[milestone-interview] Failed to parse summary event:", err);
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

/** Apply milestone interview results to the milestone */
export function applyMilestoneInterview(
  sessionId: string,
  summary?: TargetInterviewSummary,
  projectId?: string,
): Promise<Milestone> {
  return api<Milestone>(buildMilestoneInterviewUrl(sessionId, "/apply", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, summary }),
  });
}

/** Skip milestone interview and use mission context */
export function skipMilestoneInterview(
  milestoneId: string,
  projectId?: string,
): Promise<Milestone> {
  return api<Milestone>(buildMilestoneInterviewUrl(milestoneId, "/skip", projectId), {
    method: "POST",
  });
}

/** Start a slice interview session */
export function startSliceInterview(
  sliceId: string,
  projectId?: string,
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(buildSliceInterviewUrl(sliceId, "/start", projectId), {
    method: "POST",
  });
}

/** Submit a response to a slice interview question */
export function respondToSliceInterview(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
): Promise<TargetInterviewResponse> {
  return api<TargetInterviewResponse>(buildSliceInterviewUrl(sessionId, "/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

/** Connect to slice interview SSE stream and handle events */
export function connectSliceInterviewStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: TargetInterviewSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(buildSliceInterviewUrl(sessionId, `/${encodeURIComponent(sessionId)}/stream`, projectId));
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
            console.error("[slice-interview] Failed to parse question event:", err);
          }
        },
        summary: (event) => {
          try {
            handlers.onSummary?.(JSON.parse(event.data) as TargetInterviewSummary);
          } catch (err) {
            console.error("[slice-interview] Failed to parse summary event:", err);
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

/** Apply slice interview results to the slice */
export function applySliceInterview(
  sessionId: string,
  summary?: TargetInterviewSummary,
  projectId?: string,
): Promise<Slice> {
  return api<Slice>(buildSliceInterviewUrl(sessionId, "/apply", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, summary }),
  });
}

/** Skip slice interview and use mission context */
export function skipSliceInterview(
  sliceId: string,
  projectId?: string,
): Promise<Slice> {
  return api<Slice>(buildSliceInterviewUrl(sliceId, "/skip", projectId), {
    method: "POST",
  });
}

/** Preview enriched description for a feature before triage */
export async function previewEnrichedDescription(
  featureId: string,
  projectId?: string,
): Promise<{ description: string }> {
  try {
    return await api<{ description: string }>(
      withProjectId(`/missions/features/${encodeURIComponent(featureId)}/preview-description`, projectId),
      {
        method: "POST",
      }
    );
  } catch {
    // If endpoint doesn't exist, throw to trigger fallback
    throw new Error("Preview endpoint not available");
  }
}

