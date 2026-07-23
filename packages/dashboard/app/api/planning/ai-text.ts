/**
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * AI text refinement / import translation client API peeled from legacy.ts.
 */
import type { Task, TaskPriority } from "@fusion/core";
import { api, buildApiUrl } from "../client/client.js";
import { withProjectId } from "../client/health.js";
import { createResilientEventSource } from "../client/event-source.js";
import type { StreamConnectionState } from "../client/event-source.js";
import { startKeepAlive } from "./ai-sessions.js";

export interface SubtaskItem {
  id: string;
  title: string;
  description: string;
  suggestedSize: "S" | "M" | "L";
  priority?: TaskPriority;
  dependsOn: string[];
}

export interface PlanningSubtaskDraft {
  id: string;
  title?: string;
  description?: string;
  suggestedSize?: "S" | "M" | "L";
  priority?: TaskPriority;
  dependsOn?: string[];
}

// ── AI Text Refinement API ────────────────────────────────────────────

/** Refinement types for AI text refinement */
export type RefinementType = "clarify" | "add-details" | "expand" | "simplify";

/** Response from text refinement endpoint */
export interface RefineTextResponse {
  refined: string;
}

export interface DraftGoalDescriptionResponse {
  description: string;
}

/**
 * Refine task description text using AI.
 * @param text - The text to refine (1-2000 characters)
 * @param type - The refinement type: clarify, add-details, expand, or simplify
 * @param projectId - Optional project ID for scoped settings resolution
 * @returns The refined text
 * @throws Error with message for rate limit (429), invalid type (422), validation (400), or server errors
 */
export async function refineText(text: string, type: RefinementType, projectId?: string): Promise<string> {
  const response = await api<RefineTextResponse>(withProjectId("/ai/refine-text", projectId), {
    method: "POST",
    body: JSON.stringify({ text, type }),
  });
  return response.refined;
}

/**
 * Error messages for refineText failures (to use with toast notifications).
 */
export const REFINE_ERROR_MESSAGES = {
  /** Rate limit exceeded (429) */
  RATE_LIMIT: "Too many refinement requests. Please wait an hour.",
  /** Invalid refinement type (422) */
  INVALID_TYPE: "Invalid refinement option selected.",
  /** Network or server errors */
  NETWORK: "Failed to refine text. Please try again.",
} as const;

/**
 * Get user-friendly error message for a refineText error.
 * @param error - The error thrown by refineText
 * @returns A user-friendly error message suitable for toast display
 */
export function getRefineErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return REFINE_ERROR_MESSAGES.NETWORK;
  }

  const message = error.message.toLowerCase();

  // Rate limit errors (429)
  if (message.includes("rate limit") || message.includes("429")) {
    return REFINE_ERROR_MESSAGES.RATE_LIMIT;
  }

  // Invalid type errors (422)
  if (message.includes("invalid") && message.includes("type")) {
    return REFINE_ERROR_MESSAGES.INVALID_TYPE;
  }

  // Validation errors (400) - pass through from backend
  if (
    message.startsWith("text must") ||
    message.startsWith("title must") ||
    message.includes("text is required") ||
    message.includes("type is required") ||
    message.includes("title is required")
  ) {
    return error.message;
  }

  // Default network/server error
  return REFINE_ERROR_MESSAGES.NETWORK;
}

/**
 * Draft a goal description using AI from a goal title.
 * @param title - The goal title to expand into a draft description
 * @param projectId - Optional project ID for scoped settings resolution
 * @returns The drafted goal description
 * @throws Error with message for rate limit (429), validation (400), or server errors
 */
export async function draftGoalDescription(title: string, projectId?: string): Promise<string> {
  const response = await api<DraftGoalDescriptionResponse>(withProjectId("/ai/draft-goal-description", projectId), {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return response.description;
}

/*
FNXC:GitHubImportTranslate 2026-07-14-12:00:
Client for POST /api/ai/translate-text — used by the GitHub/GitLab import preview when issue/PR prose is not the dashboard language.
Structured title+body fields keep markdown import content intact; shares the AI-helper rate-limit budget with refine/draft.
*/
export interface TranslateImportFields {
  title?: string;
  body?: string;
}

export interface TranslateImportContentResponse {
  fields: TranslateImportFields;
}

/**
 * Translate import-preview title/body into the dashboard locale via AI.
 * @param fields - Original title and/or body
 * @param targetLocale - Active dashboard locale
 * @param projectId - Optional project scope for settings/MCP
 * @param sourceLocale - Optional detection hint for the model
 */
export async function translateImportContent(
  fields: TranslateImportFields,
  targetLocale: string,
  projectId?: string,
  sourceLocale?: string,
): Promise<TranslateImportFields> {
  const response = await api<TranslateImportContentResponse>(
    withProjectId("/ai/translate-text", projectId),
    {
      method: "POST",
      body: JSON.stringify({
        fields,
        targetLocale,
        ...(sourceLocale ? { sourceLocale } : {}),
      }),
    },
  );
  return response.fields;
}

/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Auto-translate the visible import list in ONE request. The server reads through its durable cache, so a repeat load of the same repo returns instantly and bills nothing; the same cache is what the import path reads, so an imported task carries the translation shown here.
The server enforces the auto-translate setting and the 50-issue cap itself and echoes `enabled`/`capped` back, so the client never has to duplicate that policy.
*/
export interface AutoTranslateImportItem {
  number: number;
  title: string;
  body: string | null;
  state?: "open" | "closed";
}

export interface AutoTranslateImportResponse {
  translations: Record<number, { title: string; body: string }>;
  enabled: boolean;
  targetLocale: string | null;
  /** True when more foreign issues existed than the per-load cap. */
  capped: boolean;
}

export async function autoTranslateImportIssues(
  owner: string,
  repo: string,
  items: AutoTranslateImportItem[],
  targetLocale: string,
  projectId?: string,
): Promise<AutoTranslateImportResponse> {
  return api<AutoTranslateImportResponse>(
    withProjectId("/github/issues/auto-translate", projectId),
    {
      method: "POST",
      body: JSON.stringify({ owner, repo, items, targetLocale }),
    },
  );
}

/** User-facing error copy for translateImportContent failures (toast/banner). */
export const TRANSLATE_ERROR_MESSAGES = {
  RATE_LIMIT: "Too many translation requests. Please wait an hour.",
  NETWORK: "Failed to translate content. Please try again.",
} as const;

/**
 * Map a translateImportContent error to banner-safe copy.
 */
export function getTranslateErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return TRANSLATE_ERROR_MESSAGES.NETWORK;
  }

  const message = error.message.toLowerCase();
  if (message.includes("rate limit") || message.includes("429")) {
    return TRANSLATE_ERROR_MESSAGES.RATE_LIMIT;
  }
  if (
    message.startsWith("fields") ||
    message.startsWith("text to translate") ||
    message.startsWith("targetlocale") ||
    message.includes("targetlocale must") ||
    message.includes("sourceLocale must")
  ) {
    return error.message;
  }
  return TRANSLATE_ERROR_MESSAGES.NETWORK;
}

export function startSubtaskBreakdown(description: string, projectId?: string): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/subtasks/start-streaming", projectId), {
    method: "POST",
    body: JSON.stringify({ description }),
  });
}

export function retrySubtaskSession(
  sessionId: string,
  projectId?: string,
): Promise<{ success: boolean; sessionId: string }> {
  return api<{ success: boolean; sessionId: string }>(
    withProjectId(`/subtasks/${encodeURIComponent(sessionId)}/retry`, projectId),
    { method: "POST" },
  );
}

export function getSubtaskStreamUrl(sessionId: string, projectId?: string): string {
  return buildApiUrl(withProjectId(`/subtasks/${encodeURIComponent(sessionId)}/stream`, projectId));
}

export function connectSubtaskStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onSubtasks?: (data: SubtaskItem[]) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  let keepAlive: { stop: () => void } | null = null;
  let connection: { close: () => void; isConnected: () => boolean } | null = null;

  const stopKeepAlive = () => {
    keepAlive?.stop();
    keepAlive = null;
  };

  const resilient = createResilientEventSource(
    getSubtaskStreamUrl(sessionId, projectId),
    {
      onOpen: () => {
        stopKeepAlive();
        keepAlive = startKeepAlive(sessionId, projectId);
      },
      events: {
        thinking: (event) => {
          try {
            handlers.onThinking?.(JSON.parse(event.data));
          } catch {
            handlers.onThinking?.(event.data);
          }
        },
        subtasks: (event) => {
          try {
            handlers.onSubtasks?.(JSON.parse(event.data) as SubtaskItem[]);
          } catch (err) {
            console.error("[subtasks] Failed to parse subtasks event:", err);
          }
        },
        error: (event) => {
          try {
            const parsedData = JSON.parse(event.data);
            const errorMessage = typeof parsedData === "string" && parsedData.length > 0 ? parsedData : null;
            handlers.onError?.(errorMessage || "Stream error");
          } catch {
            handlers.onError?.("Stream error");
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

export function createTasksFromBreakdown(
  sessionId: string,
  subtasks: SubtaskItem[],
  parentTaskId?: string,
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
    workflowId?: string | null;
  },
): Promise<{ tasks: Task[]; parentTaskClosed?: boolean }> {
  return api<{ tasks: Task[]; parentTaskClosed?: boolean }>(withProjectId("/subtasks/create-tasks", projectId), {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      parentTaskId,
      ...(options?.branch !== undefined ? { branch: options.branch } : {}),
      ...(options?.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
      ...(options?.branchSelection ? { branchSelection: options.branchSelection } : {}),
      ...(options?.branchAssignment ? { branchAssignment: options.branchAssignment } : {}),
      ...(options?.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
      subtasks: subtasks.map((subtask) => ({
        tempId: subtask.id,
        title: subtask.title,
        description: subtask.description,
        size: subtask.suggestedSize,
        ...(subtask.priority !== undefined ? { priority: subtask.priority } : {}),
        dependsOn: subtask.dependsOn,
      })),
    }),
  });
}

export function cancelSubtaskBreakdown(sessionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId("/subtasks/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

