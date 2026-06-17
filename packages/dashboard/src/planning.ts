/**
 * Planning Mode Session Management
 *
 * Manages AI-guided planning sessions for interactive task creation.
 * Sessions are stored in-memory with TTL cleanup.
 * 
 * Features:
 * - AI agent integration via createFnAgent for real-time planning conversations
 * - Streaming via SSE (createSessionWithAgent) and non-streaming (createSession)
 * - Rate limiting per IP
 * - Session expiration and cleanup
 * - JSON response parsing with robust extraction and repair
 */

import type {
  PlanningQuestion,
  PlanningSummary,
  PlanningResponse,
  TaskPriority,
  TaskStore,
  NtfyNotificationEvent,
} from "@fusion/core";
import { DEFAULT_TASK_PRIORITY, resolvePrompt, summarizeTitle, type PromptOverrideMap } from "@fusion/core";
import type { SubtaskItem } from "./subtask-breakdown.js";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AiSessionStore, AiSessionRow } from "./ai-session-store.js";
import { SessionEventBuffer, type SessionBufferedEvent } from "./sse-buffer.js";
import { registerBeforeExitCleanup } from "./process-lifecycle.js";
import {
  createSessionDiagnostics,
  resetDiagnosticsSink,
  nonfatal,
} from "./ai-session-diagnostics.js";
import {
  createFnAgent as engineCreateFnAgent,
  createWorkflowAuthoringTools,
} from "@fusion/engine";
import * as engineModule from "@fusion/engine";
import { createPlanningBoardTools } from "./planning-board-tools.js";

// The planning lane has no ambient task; fn_workflow_select therefore has no
// default target and an agent must pass an explicit task_id.
const PLANNING_NO_AMBIENT_TASK_ID = "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentResult = any;

const PLANNING_BUILTIN_WEB_TOOLS = ["WebSearch", "WebFetch"] as const;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createFnAgent: any = engineCreateFnAgent;

// ── Notification Integration ────────────────────────────────────────────
//
// The planning module sends "planning-awaiting-input" notifications when an
// AI planning session needs user input. Currently this uses ntfy-specific
// helpers loaded dynamically from @fusion/engine.
//
// The engine now exposes a pluggable NotificationService abstraction
// (NotificationService + NotificationProvider interface) that dispatches
// events to registered providers (ntfy, webhook, etc.). The planning module
// will migrate to using NotificationService.dispatch() for a provider-
// agnostic flow once the broader notification integration is complete.
//
// For now, the ntfy-specific path remains active because "planning-awaiting-input"
// is only supported by the ntfy provider and is not dispatched through the
// NotificationService event listeners (which handle task:moved, task:updated,
// task:merged, settings:updated).

/**
 * Configuration for planning session notifications.
 *
 * Currently drives ntfy-specific notifications for the "planning-awaiting-input" event.
 * This will be generalized to support the pluggable NotificationService abstraction
 * (from @fusion/engine) once additional providers support planning events.
 * Kept as "Ntfy" in the name for backward compatibility with existing call sites.
 */
interface PlanningNtfyConfig {
  enabled: boolean;
  topic?: string;
  dashboardHost?: string;
  events?: NtfyNotificationEvent[];
  ntfyBaseUrl?: string;
}

/**
 * Ntfy-specific helper functions loaded from @fusion/engine at runtime.
 *
 * These wrap the engine's exported notification helpers. In the future, this
 * will be replaced by direct use of NotificationService.dispatch() for a
 * provider-agnostic notification flow.
 */
interface PlanningNtfyHelpers {
  isNtfyEventEnabled: (events: NtfyNotificationEvent[] | undefined, event: NtfyNotificationEvent) => boolean;
  buildNtfyClickUrl: (options: { dashboardHost?: string; projectId?: string; taskId?: string }) => string | undefined;
  sendNtfyNotification: (input: {
    ntfyBaseUrl?: string;
    topic: string;
    title: string;
    message: string;
    priority?: "low" | "default" | "high" | "urgent";
    clickUrl?: string;
  }) => Promise<void>;
}

/** Cached notification helpers. Loaded lazily by ensureNtfyHelpersReady(). */
let planningNtfyHelpers: PlanningNtfyHelpers | undefined;

/**
 * Shared diagnostics helper for the planning module.
 * Uses the shared ai-session-diagnostics helper for consistent scoped logging.
 * @see ai-session-diagnostics.ts for the shared contract
 */
const diagnostics = createSessionDiagnostics("planning");

/**
 * Get the current diagnostics logger (for backward compatibility).
 * @internal - exposed for test hook
 */
export function __getPlanningDiagnostics() {
  return diagnostics;
}

/**
 * Inject a diagnostics sink (test-only).
 * Delegates to the shared ai-session-diagnostics sink.
 * When a sink is injected, all planning module diagnostics route through it.
 * This allows tests to assert on diagnostics without global console spies.
 */
export function __setPlanningDiagnostics(_logger: unknown): void {
  // For backward compatibility, we keep this function but it now delegates
  // to the shared helper's sink mechanism. The actual sink injection
  // should use setDiagnosticsSink() from ai-session-diagnostics.
  // This function is kept for backward compatibility with existing tests.
  if (_logger === null) {
    resetDiagnosticsSink();
  }
}

function ensureEngineReady(): Promise<void> {
  return Promise.resolve();
}

async function ensureNtfyHelpersReady(): Promise<void> {
  if (planningNtfyHelpers) {
    return;
  }

  const hasNotificationService = "NotificationService" in engineModule
    && typeof engineModule.NotificationService === "function";

  const hasAllHelpers =
    "isNtfyEventEnabled" in engineModule
    && "buildNtfyClickUrl" in engineModule
    && "sendNtfyNotification" in engineModule
    && typeof engineModule.isNtfyEventEnabled === "function"
    && typeof engineModule.buildNtfyClickUrl === "function"
    && typeof engineModule.sendNtfyNotification === "function";

  if (!hasAllHelpers) {
    return;
  }

  planningNtfyHelpers = {
    isNtfyEventEnabled: engineModule.isNtfyEventEnabled,
    buildNtfyClickUrl: engineModule.buildNtfyClickUrl,
    sendNtfyNotification: engineModule.sendNtfyNotification,
  };

  if (hasNotificationService) {
    diagnostics.info(
      "NotificationService abstraction detected in engine",
      { operation: "notification-service-detection" },
    );
  }
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Planning system prompt for the AI agent */
export const PLANNING_SYSTEM_PROMPT = `You are a planning assistant for the fn task board system.

Your job: help users transform vague, high-level ideas into well-defined, actionable tasks.

## Conversation Flow
1. User provides a high-level plan (e.g., "Build a user auth system")
2. You ask clarifying questions to understand scope, requirements, and constraints
3. You present UI-friendly selection options when appropriate
4. Once you have enough information, generate a structured summary

## Question Types to Use
- "text": Open-ended follow-up questions for detailed input
- "single_select": When user must choose one option (e.g., tech stack preference)
- "multi_select": When multiple options can apply (e.g., features to include)
- "confirm": Yes/No questions for quick decisions

## Guidelines
- Ask 3-7 questions depending on complexity
- Start broad, then narrow down specifics
- Suggest sensible defaults based on project context
- Keep questions focused and actionable
- When asking about file scope, reference actual project structure

## Summary Generation
When ready to complete, generate:
- A concise but descriptive title (max 80 chars)
- A detailed description with context gathered
- Size estimate (S/M/L) based on scope
- Any suggested dependencies on existing tasks
- Key deliverables as a checklist

## Board tools
- fn_task_list — list active tasks
- fn_task_get — read a task's full details and PROMPT.md
Use these to avoid duplicating an existing in-flight plan and to anchor your questions against current backlog context.

## Response Format
Always respond with valid JSON in one of these formats:

For questions:
{\n  "type": "question",\n  "data": {\n    "id": "unique-id",\n    "type": "text|single_select|multi_select|confirm",\n    "question": "The question text",\n    "description": "Helpful context",\n    "options": [{"id": "opt1", "label": "Option 1", "description": "Details"}]\n  }\n}

For completion:
{\n  "type": "complete",\n  "data": {\n    "title": "Task title",\n    "description": "Detailed description",\n    "suggestedSize": "S|M|L",\n    "suggestedDependencies": [],\n    "keyDeliverables": ["Item 1", "Item 2"]\n  }\n}`;

/** Placeholder title for draft sessions before the user starts planning. */
export const DRAFT_PLACEHOLDER_TITLE = "New planning session";

/**
 * Shape of the JSON blob persisted in `ai_sessions.inputPayload` for draft
 * planning sessions. Carries the in-progress plan text plus an optional
 * model override so reopening a draft restores the model selection the user
 * picked at create time, and so summarizeDraftTitle calls hit that same
 * model rather than silently falling back to project defaults.
 *
 * `summarizedFor` records the exact `initialPlan` string the current
 * persisted title was summarized from. The start-existing path uses it to
 * skip re-summarizing when blur/close already produced a title for the
 * final text, avoiding a redundant model call.
 */
export interface DraftInputPayload {
  initialPlan?: string;
  modelProvider?: string;
  modelId?: string;
  summarizedFor?: string;
}

/** Session TTL in milliseconds (7 days) */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cleanup interval in milliseconds (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Max planning sessions per IP per hour */
const MAX_SESSIONS_PER_IP_PER_HOUR = 1000;

/** Rate limiting window in milliseconds (1 hour) */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Generation timeout in milliseconds (120 seconds). */
export const GENERATION_TIMEOUT_MS = 120_000;

export type PlanningDepth = "small" | "medium" | "large";

const PLANNING_DEPTH_PROMPT_SUFFIX: Record<PlanningDepth, string> = {
  small:
    "Ask exactly 1-2 focused questions. Prioritize speed and getting to a summary quickly. Skip optional clarification.",
  medium:
    "Ask 3-5 well-rounded questions. Balance breadth and depth. This is the default behavior.",
  large:
    "Ask 5-8 thorough questions. Deeply explore scope, edge cases, dependencies, and implementation details. Be comprehensive.",
};

export function buildDepthPromptSuffix(
  depth?: PlanningDepth,
  customQuestionCount?: number,
): string {
  if (Number.isInteger(customQuestionCount) && (customQuestionCount ?? 0) > 0) {
    return `Ask exactly ${customQuestionCount} questions. Adjust depth and breadth to fit within that count.`;
  }

  if (!depth) {
    return "";
  }

  return PLANNING_DEPTH_PROMPT_SUFFIX[depth];
}

// ── Types ───────────────────────────────────────────────────────────────────

/** SSE event types for planning session streaming */
export type PlanningStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "question"; data: PlanningQuestion }
  | { type: "summary"; data: PlanningSummary }
  | { type: "error"; data: string }
  | { type: "complete" };

/** Callback function for streaming events */
export type PlanningStreamCallback = (event: PlanningStreamEvent, eventId?: number) => void;

interface PlanningHistoryEntry {
  question: PlanningQuestion;
  response: unknown;
  thinkingOutput?: string;
}

interface Session {
  id: string;
  ip: string;
  initialPlan: string;
  title: string;
  projectId?: string;
  /** Model override the user picked at draft-create time. Persisted in inputPayload so reopen restores it. */
  draftModelProvider?: string;
  draftModelId?: string;
  /** Plan text the current title was summarized from; lets startExistingSession skip a redundant re-summarize when blur/close already covered the final text. */
  draftSummarizedFor?: string;
  ntfyConfig?: PlanningNtfyConfig;
  autoMerge?: boolean;
  /** Last planning question notified via ntfy, keyed as `${sessionId}:${questionId}` for dedupe across reconnect/replay. */
  lastNotifiedQuestionKey?: string;
  history: PlanningHistoryEntry[];
  currentQuestion?: PlanningQuestion;
  summary?: PlanningSummary;
  /** Last terminal error for retry UX */
  error?: string;
  /** AI agent session for real-time interaction */
  agent?: AgentResult;
  /**
   * TaskStore reference captured at session creation. Used by
   * ensureSessionAgent to rebuild the agent after rehydration (when no
   * store is plumbed through the submitResponse/retry/rewind call sites).
   * Not persisted — restored only for the lifetime of the in-memory session.
   */
  store?: TaskStore;
  /** Project root captured at session creation; mirrors `store` for agent rebuild. */
  rootDir?: string;
  /** Callback for streaming events to SSE clients */
  streamCallback?: PlanningStreamCallback;
  /** Accumulated thinking output for display */
  thinkingOutput: string;
  /** Thinking output generated while producing currentQuestion */
  lastGeneratedThinking: string;
  createdAt: Date;
  updatedAt: Date;
}

interface RateLimitEntry {
  count: number;
  firstRequestAt: Date;
}

// ── In-Memory Storage ───────────────────────────────────────────────────────

/** Active planning sessions indexed by session ID */
const sessions = new Map<string, Session>();

/** Rate limiting state indexed by IP */
const rateLimits = new Map<string, RateLimitEntry>();

/** Active planning generations keyed by session ID. */
const activeGenerations = new Map<string, { abortController: AbortController; timer: NodeJS.Timeout }>();

// ── AI Session Persistence ────────────────────────────────────────────────

/** Optional store for persisting session state across reloads/browsers. */
let _aiSessionStore: AiSessionStore | undefined;
let _aiSessionDeletedListener: ((sessionId: string) => void) | undefined;

function safeParseJson<T>(
  text: string | null,
  fallback: T,
  options?: { throwOnError?: boolean; fieldName?: string },
): T {
  if (!text) {
    return fallback;
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    if (options?.throwOnError) {
      const fieldSuffix = options.fieldName ? ` in ${options.fieldName}` : "";
      throw new Error(`Invalid JSON${fieldSuffix}: ${(error as Error).message}`);
    }
    return fallback;
  }
}

/** Wire up the AI session persistence store. Called once from server.ts. */
export function setAiSessionStore(store: AiSessionStore): void {
  if (_aiSessionStore && _aiSessionDeletedListener) {
    _aiSessionStore.off("ai_session:deleted", _aiSessionDeletedListener);
  }

  _aiSessionStore = store;
  _aiSessionDeletedListener = (sessionId: string) => {
    cleanupInMemorySession(sessionId);
  };
  _aiSessionStore.on("ai_session:deleted", _aiSessionDeletedListener);
}

function cleanupInMemorySession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  const activeGeneration = activeGenerations.get(sessionId);
  if (activeGeneration) {
    clearTimeout(activeGeneration.timer);
    activeGenerations.delete(sessionId);
  }

  if (session.agent) {
    try {
      const disposeResult = session.agent.session.dispose?.();
      if (disposeResult) {
        disposeResult.catch((err: unknown) => {
          diagnostics.errorFromException("Error disposing agent for session", err, { sessionId, operation: "dispose-session" });
        });
      }
    } catch (err) {
      diagnostics.errorFromException("Error disposing agent for session", err, { sessionId, operation: "dispose-session" });
    }
    session.agent = undefined;
  }

  planningStreamManager.cleanupSession(sessionId);
  sessions.delete(sessionId);
  return true;
}

/** Persist the current session state to SQLite (no-op if store not wired). */
function persistSession(session: Session, status: "generating" | "awaiting_input" | "complete" | "error" | "draft", error?: string): void {
  if (!_aiSessionStore) return;
  const row: AiSessionRow = {
    id: session.id,
    type: "planning",
    status,
    title: session.title || session.initialPlan.slice(0, 120),
    inputPayload: JSON.stringify({
      ip: session.ip,
      initialPlan: session.initialPlan,
      ...(session.draftModelProvider ? { modelProvider: session.draftModelProvider } : {}),
      ...(session.draftModelId ? { modelId: session.draftModelId } : {}),
      ...(session.draftSummarizedFor ? { summarizedFor: session.draftSummarizedFor } : {}),
    }),
    conversationHistory: JSON.stringify(session.history),
    currentQuestion: session.currentQuestion ? JSON.stringify(session.currentQuestion) : null,
    result: session.summary ? JSON.stringify(session.summary) : null,
    thinkingOutput: session.thinkingOutput,
    error: error ?? null,
    projectId: session.projectId ?? null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: new Date().toISOString(),
    lockedByTab: null,
    lockedAt: null,
  };
  _aiSessionStore.upsert(row);
}

/** Persist only thinking output (debounced). */
function persistThinking(sessionId: string, thinkingOutput: string): void {
  if (!_aiSessionStore) return;
  _aiSessionStore.updateThinking(sessionId, thinkingOutput);
}

/** Remove session from persistence. */
function unpersistSession(sessionId: string): void {
  if (!_aiSessionStore) return;
  _aiSessionStore.delete(sessionId);
}

/** Release in-memory planning runtime state while keeping persisted history. */
export function releaseSession(sessionId: string): void {
  cleanupInMemorySession(sessionId);
}

function buildSessionFromRow(row: AiSessionRow): Session {
  const payload = safeParseJson<DraftInputPayload & { ip?: string }>(
    row.inputPayload,
    {},
    { throwOnError: true, fieldName: "inputPayload" },
  );

  const createdAt = new Date(row.createdAt);
  const updatedAt = new Date(row.updatedAt);

  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())) {
    throw new Error("Invalid session timestamps");
  }

  const currentQuestion = row.currentQuestion
    ? (safeParseJson<PlanningQuestion | null>(row.currentQuestion, null, {
        throwOnError: true,
        fieldName: "currentQuestion",
      }) ?? undefined)
    : undefined;

  return {
    id: row.id,
    ip: payload.ip ?? "",
    initialPlan: payload.initialPlan ?? row.title,
    title: row.title,
    projectId: row.projectId ?? undefined,
    draftModelProvider: payload.modelProvider,
    draftModelId: payload.modelId,
    draftSummarizedFor: payload.summarizedFor,
    history: safeParseJson<PlanningHistoryEntry[]>(
      row.conversationHistory,
      [],
      { throwOnError: true, fieldName: "conversationHistory" },
    ),
    currentQuestion,
    lastNotifiedQuestionKey: currentQuestion ? `${row.id}:${currentQuestion.id}` : undefined,
    summary: row.result
      ? (safeParseJson<PlanningSummary | null>(row.result, null, {
          throwOnError: true,
          fieldName: "result",
        }) ?? undefined)
      : undefined,
    thinkingOutput: row.thinkingOutput,
    lastGeneratedThinking: row.thinkingOutput || "",
    error: row.error ?? undefined,
    createdAt,
    updatedAt,
    agent: undefined,
  };
}

export function rehydrateFromStore(store: AiSessionStore): number {
  let rows: AiSessionRow[] = [];

  try {
    rows = store.listRecoverable().filter((row) => row.type === "planning");
  } catch (error) {
    diagnostics.errorFromException("Failed to list recoverable sessions", error, { operation: "list-recoverable" });
    return 0;
  }

  let rehydrated = 0;
  for (const row of rows) {
    try {
      const session = buildSessionFromRow(row);
      sessions.set(session.id, session);
      rehydrated += 1;
    } catch (error) {
      diagnostics.errorFromException("Failed to rehydrate session", error, { sessionId: row.id, operation: "rehydrate" });
    }
  }

  return rehydrated;
}

// ── Cleanup Interval ────────────────────────────────────────────────────────

/**
 * Remove expired sessions and stale rate limit entries.
 * Runs periodically via setInterval.
 */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  let cleanedSessions = 0;
  let cleanedRateLimits = 0;

  // Clean up expired sessions
  for (const [id, session] of sessions) {
    if (now - session.updatedAt.getTime() > SESSION_TTL_MS) {
      if (cleanupInMemorySession(id)) {
        cleanedSessions++;
      }
    }
  }

  // Clean up stale rate limit entries
  for (const [ip, entry] of rateLimits) {
    if (now - entry.firstRequestAt.getTime() > RATE_LIMIT_WINDOW_MS) {
      rateLimits.delete(ip);
      cleanedRateLimits++;
    }
  }

  if (cleanedSessions > 0 || cleanedRateLimits > 0) {
    diagnostics.info(
      "Cleanup completed",
      { cleanedSessions, cleanedRateLimits, operation: "cleanup-expired" }
    );
  }
}

// Start cleanup interval
const cleanupInterval = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
cleanupInterval.unref?.();

// Handle graceful shutdown
registerBeforeExitCleanup(() => {
  clearInterval(cleanupInterval);
});

// ── Planning Stream Manager ─────────────────────────────────────────────────

/**
 * Manages SSE connections for active planning sessions.
 * Each session can have multiple connected clients receiving streaming updates.
 */
export class PlanningStreamManager extends EventEmitter {
  private readonly sessions = new Map<string, Set<PlanningStreamCallback>>();
  private readonly buffers = new Map<string, SessionEventBuffer>();
  private readonly pendingInitialTurns = new Map<string, () => void>();

  constructor(private readonly bufferSize = 100) {
    super();
  }

  /**
   * Register a client callback for a planning session.
   * Returns a function to unsubscribe.
   */
  subscribe(sessionId: string, callback: PlanningStreamCallback): () => void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Set());
    }

    const callbacks = this.sessions.get(sessionId)!;
    callbacks.add(callback);

    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.sessions.delete(sessionId);
      }
    };
  }

  private getBuffer(sessionId: string): SessionEventBuffer {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = new SessionEventBuffer(this.bufferSize);
      this.buffers.set(sessionId, buffer);
    }
    return buffer;
  }

  /**
   * Broadcast an event to all clients subscribed to a session.
   * Every event is buffered and assigned a monotonically increasing id.
   */
  broadcast(sessionId: string, event: PlanningStreamEvent): number {
    const serialized = JSON.stringify((event as { data?: unknown }).data ?? {});
    const eventData = typeof serialized === "string" ? serialized : "{}";
    const eventId = this.getBuffer(sessionId).push(event.type, eventData);

    const callbacks = this.sessions.get(sessionId);
    if (!callbacks) return eventId;

    for (const callback of callbacks) {
      nonfatal(
        () => callback(event, eventId),
        diagnostics,
        "Error broadcasting to client",
        { sessionId, operation: "broadcast" }
      );
    }

    return eventId;
  }

  /**
   * Get buffered events with id > sinceId for the session.
   */
  getBufferedEvents(sessionId: string, sinceId: number): SessionBufferedEvent[] {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return [];
    return buffer.getEventsSince(sinceId);
  }

  registerInitialTurn(sessionId: string, start: () => void): void {
    if (this.pendingInitialTurns.has(sessionId)) {
      throw new Error(`Initial planning turn already registered for session ${sessionId}`);
    }
    this.pendingInitialTurns.set(sessionId, start);
  }

  consumeInitialTurn(sessionId: string): (() => void) | undefined {
    const start = this.pendingInitialTurns.get(sessionId);
    if (!start) {
      return undefined;
    }
    this.pendingInitialTurns.delete(sessionId);
    return start;
  }

  /**
   * Check if a session has active subscribers.
   */
  hasSubscribers(sessionId: string): boolean {
    const callbacks = this.sessions.get(sessionId);
    return callbacks !== undefined && callbacks.size > 0;
  }

  /**
   * Get the number of subscribers for a session.
   */
  getSubscriberCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.size ?? 0;
  }

  /**
   * Clean up all subscriptions and buffered events for a session.
   */
  cleanupSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.buffers.delete(sessionId);
    this.pendingInitialTurns.delete(sessionId);
  }

  /**
   * Reset all subscriptions and buffers (test helper).
   */
  reset(): void {
    this.sessions.clear();
    this.buffers.clear();
    this.pendingInitialTurns.clear();
    this.removeAllListeners();
  }
}

/** Singleton instance of the planning stream manager */
export const planningStreamManager = new PlanningStreamManager();

// ── Rate Limiting ───────────────────────────────────────────────────────────

/**
 * Check if IP can create a new planning session.
 * Returns true if allowed, false if rate limited.
 */
export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry) {
    // First request from this IP
    rateLimits.set(ip, {
      count: 1,
      firstRequestAt: new Date(),
    });
    return true;
  }

  // Check if window has expired
  if (now - entry.firstRequestAt.getTime() > RATE_LIMIT_WINDOW_MS) {
    // Reset window
    rateLimits.set(ip, {
      count: 1,
      firstRequestAt: new Date(),
    });
    return true;
  }

  // Within window - check limit
  if (entry.count >= MAX_SESSIONS_PER_IP_PER_HOUR) {
    return false;
  }

  // Increment count
  entry.count++;
  return true;
}

/**
 * Get rate limit reset time for an IP.
 * Returns null if no rate limit entry exists.
 */
export function getRateLimitResetTime(ip: string): Date | null {
  const entry = rateLimits.get(ip);
  if (!entry) return null;

  return new Date(entry.firstRequestAt.getTime() + RATE_LIMIT_WINDOW_MS);
}

// ── Session Management ───────────────────────────────────────────────────────

/**
 * Create a new planning session.
 * Uses stubbed AI logic for immediate response (no streaming).
 * For streaming AI responses, use createSessionWithAgent.
 */
export async function createSession(
  ip: string,
  initialPlan: string,
  store?: TaskStore,
  rootDir?: string,
  promptOverrides?: PromptOverrideMap,
  planningDepth?: PlanningDepth,
  customQuestionCount?: number,
): Promise<{ sessionId: string; firstQuestion: PlanningQuestion }> {
  // Check rate limit
  if (!checkRateLimit(ip)) {
    const resetTime = getRateLimitResetTime(ip);
    throw new RateLimitError(
      `Rate limit exceeded. Maximum ${MAX_SESSIONS_PER_IP_PER_HOUR} planning sessions per hour. ` +
        `Reset at ${resetTime?.toISOString() || "unknown"}`
    );
  }

  if (!rootDir) {
    throw new Error("rootDir is required for AI-powered planning sessions");
  }
  if (!store) {
    throw new Error("store is required for AI-powered planning sessions");
  }

  const sessionId = randomUUID();

  const session: Session = {
    id: sessionId,
    ip,
    initialPlan,
    title: initialPlan.slice(0, 120),
    history: [],
    thinkingOutput: "",
    lastGeneratedThinking: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    store,
    rootDir,
  };

  sessions.set(sessionId, session);
  persistSession(session, "generating");

  // Resolve the effective system prompt (override or default)
  const baseSystemPrompt = resolvePrompt("planning-system", promptOverrides) || PLANNING_SYSTEM_PROMPT;
  const depthPromptSuffix = buildDepthPromptSuffix(planningDepth, customQuestionCount);
  const systemPrompt = depthPromptSuffix ? `${baseSystemPrompt}\n\n${depthPromptSuffix}` : baseSystemPrompt;

  // Create AI agent and get the first question
  // Only await engineReady if createFnAgent hasn't been set externally (e.g., via __setCreateFnAgent)
  if (!createFnAgent) {
    await ensureEngineReady();
  }

  const agentResult = await createFnAgent({
    cwd: rootDir,
    systemPrompt,
    tools: "readonly",
    builtinToolsAllowlist: [...PLANNING_BUILTIN_WEB_TOOLS],
    customTools: [
      ...createPlanningBoardTools(store),
      ...createWorkflowAuthoringTools(store, PLANNING_NO_AMBIENT_TASK_ID, { stripApprovalFlags: true }),
    ],
    onThinking: () => {
      // Non-streaming path ignores thinking output
    },
    onText: () => {
      // Non-streaming path ignores incremental text
    },
  });

  session.agent = agentResult;
  session.updatedAt = new Date();

  // Send initial plan to get first question from AI
  const firstQuestion = await getFirstQuestionFromAgent(session, initialPlan);

  session.currentQuestion = firstQuestion;
  session.updatedAt = new Date();
  persistSession(session, "awaiting_input");

  return { sessionId, firstQuestion };
}

/**
 * Get the first question from the AI agent by sending the initial plan.
 * Waits for the agent response and parses it as a PlanningQuestion.
 * Throws if the agent returns a summary instead of a question.
 */
async function getFirstQuestionFromAgent(
  session: Session,
  message: string
): Promise<PlanningQuestion> {
  if (!session.agent) {
    throw new InvalidSessionStateError("AI agent not initialized");
  }

  // Send message to agent
  await session.agent.session.prompt(message);

  // Extract response text
  interface AgentMessage {
    role: string;
    content?: string | Array<{ type: string; text?: string; thinking?: string }>;
  }
  const lastMessage = (session.agent.session.state.messages as AgentMessage[])
    .filter((m: AgentMessage) => m.role === "assistant")
    .pop();

  let responseText = "";
  if (lastMessage?.content) {
    if (typeof lastMessage.content === "string") {
      responseText = lastMessage.content;
    } else if (Array.isArray(lastMessage.content)) {
      // Try text blocks first
      const textContent = lastMessage.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("");
      if (textContent) {
        responseText = textContent;
      } else {
        // Fallback: extract thinking blocks when no text blocks are present
        const thinkingContent = lastMessage.content
          .filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking" && typeof c.thinking === "string")
          .map((c) => c.thinking)
          .join("");
        responseText = thinkingContent;
      }
    }
  }

  // Diagnostic: warn when response text is empty or very short
  if (!responseText || responseText.length < 10) {
    const contentBlockTypes = Array.isArray(lastMessage?.content)
      ? lastMessage.content.map((c: { type: string }) => c.type)
      : typeof lastMessage?.content === "string" ? ["string"] : [];
    diagnostics.warn(
      "Response text is empty or very short before parse",
      {
        sessionId: session.id,
        responseTextLength: responseText.length,
        contentBlockTypes,
        usedThinkingBlocksFallback: !Array.isArray(lastMessage?.content) ? false : !lastMessage.content.some((c: { type: string }) => c.type === "text"),
        operation: "response-extraction",
      }
    );
  }

  // Parse response with retry
  let parsed: PlanningResponse | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
    try {
      parsed = parseAgentResponse(responseText);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < MAX_PARSE_RETRIES) {
        try {
          await session.agent.session.prompt(
            "Your previous response could not be parsed as JSON. " +
            'Please respond with ONLY a valid JSON object: {"type":"question","data":{...}}. ' +
            "No markdown, no explanation, just the JSON."
          );

          const retryMessage = (session.agent.session.state.messages as AgentMessage[])
            .filter((m: AgentMessage) => m.role === "assistant")
            .pop();

          if (retryMessage?.content) {
            if (typeof retryMessage.content === "string") {
              responseText = retryMessage.content;
            } else if (Array.isArray(retryMessage.content)) {
              const textContent = retryMessage.content
                .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
                .map((c) => c.text)
                .join("");
              if (textContent) {
                responseText = textContent;
              } else {
                const thinkingContent = retryMessage.content
                  .filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking" && typeof c.thinking === "string")
                  .map((c) => c.thinking)
                  .join("");
                responseText = thinkingContent;
              }
            }
          }
        } catch {
          break;
        }
      }
    }
  }

  if (!parsed) {
    // Clean up the failed startup session and release the underlying agent so
    // an unparsable first response cannot leave model/transport handles behind
    // in the long-running dashboard process.
    sessions.delete(session.id);
    unpersistSession(session.id);
    try {
      await session.agent.session.dispose?.();
    } catch (disposeErr) {
      diagnostics.warn("Failed to dispose planning agent after first question failure", {
        sessionId: session.id,
        message: disposeErr instanceof Error ? disposeErr.message : String(disposeErr),
        operation: "dispose-after-first-question-failure",
      });
    }
    session.agent = undefined;
    throw new Error(
      `Failed to get first question from AI: ${lastError?.message || "Unknown error"}`
    );
  }

  if (parsed.type === "complete") {
    // AI returned a summary instead of a question — return a minimal question
    // so the caller can present the summary
    const summary = parsed.data;
    session.summary = summary;
    persistSession(session, "complete");
    return {
      id: "q-direct-summary",
      type: "confirm",
      question: `The AI has generated a plan: "${summary.title}". Proceed with this?`,
      description: summary.description,
    };
  }

  return parsed.data;
}

export async function createDraftSession(
  ip: string,
  initialPlan: string,
  _rootDir: string,
  modelProvider?: string,
  modelId?: string,
  _promptOverrides?: PromptOverrideMap,
  options?: { projectId?: string },
): Promise<{ sessionId: string; title: string }> {
  if (!checkRateLimit(ip)) {
    const resetTime = getRateLimitResetTime(ip);
    throw new RateLimitError(
      `Rate limit exceeded. Maximum ${MAX_SESSIONS_PER_IP_PER_HOUR} planning sessions per hour. ` +
        `Reset at ${resetTime?.toISOString() || "unknown"}`,
    );
  }

  const sessionId = randomUUID();
  const title = DRAFT_PLACEHOLDER_TITLE;

  // Pair modelProvider+modelId — the runtime treats half-set overrides as
  // invalid (resolveTaskPlanningModel etc.), so persist nothing rather than
  // a half-configured override that would mislead reopen.
  const hasModelOverride = Boolean(modelProvider && modelId);

  const session: Session = {
    id: sessionId,
    ip,
    initialPlan,
    title,
    projectId: options?.projectId,
    draftModelProvider: hasModelOverride ? modelProvider : undefined,
    draftModelId: hasModelOverride ? modelId : undefined,
    history: [],
    thinkingOutput: "",
    lastGeneratedThinking: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  sessions.set(sessionId, session);
  persistSession(session, "draft");

  return { sessionId, title };
}

/**
 * Replace a draft session's placeholder sidebar title with an AI-summarized
 * one derived from the latest persisted initialPlan. Bounded by status, not
 * by title content, so a user who blurs once then keeps editing still gets
 * the title refreshed on subsequent blurs/close (otherwise the title would
 * lock to the first summary and silently diverge from what they typed).
 *  - Only runs against rows still in `draft` status — once a session has been
 *    started, its title is owned by the start path / final summary and must
 *    not be overwritten by a stale draft summarize call that arrives late.
 *  - Reads the current initialPlan and any persisted model override from
 *    SQLite so the summary reflects whatever the latest debounced PATCH
 *    /draft persisted, and uses the model the draft was created under.
 *  - Re-checks status (not title) after the model call to detect a
 *    concurrent start and avoid clobbering the generating/awaiting_input
 *    title with a stale draft summary.
 *
 * Returns the resolved title (existing or freshly generated) or null if the
 * session was not eligible for summarization.
 */
export async function summarizeDraftTitle(
  sessionId: string,
  rootDir: string,
  modelProvider?: string,
  modelId?: string,
): Promise<string | null> {
  if (!_aiSessionStore) return null;

  const row = _aiSessionStore.get(sessionId);
  if (!row || row.type !== "planning" || row.status !== "draft") {
    return null;
  }

  const payload = safeParseJson<DraftInputPayload>(row.inputPayload, {});
  const trimmed = (payload.initialPlan ?? "").trim();
  if (!trimmed) return null;

  // Prefer the model the draft was created under; fall back to the caller-
  // supplied override (e.g. project/global planning settings).
  const effectiveProvider = payload.modelProvider ?? modelProvider;
  const effectiveModelId = payload.modelId ?? modelId;

  let finalTitle = trimmed.slice(0, 60).trim();
  try {
    const generated = await summarizeTitle(trimmed, rootDir, effectiveProvider, effectiveModelId);
    finalTitle = generated?.trim() || finalTitle;
  } catch (error) {
    diagnostics.errorFromException(
      "summarizeDraftTitle: model call failed, falling back to truncated text",
      error,
      { sessionId, operation: "summarize-draft-title" },
    );
  }

  if (!finalTitle) return null;

  // Re-check status (not title) so a concurrent Start Planning or a later
  // edit-then-blur cycle doesn't overwrite a real generating/complete title.
  const latest = _aiSessionStore.get(sessionId);
  if (!latest || latest.status !== "draft") {
    return latest?.title ?? null;
  }

  _aiSessionStore.markDraftSummarized(sessionId, finalTitle, trimmed);
  const session = sessions.get(sessionId);
  if (session) {
    session.title = finalTitle;
    session.draftSummarizedFor = trimmed;
  }
  return finalTitle;
}

export async function startExistingSession(
  sessionId: string,
  rootDir: string,
  store: TaskStore,
  modelProvider?: string,
  modelId?: string,
  promptOverrides?: PromptOverrideMap,
): Promise<void> {
  let session = sessions.get(sessionId);

  // Draft sessions aren't included in rehydrateFromStore (which only loads
  // recoverable in-flight sessions), and a backend restart drops the in-memory
  // map entirely. Rebuild lazily from SQLite so persisted drafts can still be
  // started after a restart, and so updateDraft-only state survives.
  if (!session && _aiSessionStore) {
    const row = _aiSessionStore.get(sessionId);
    if (row && row.type === "planning") {
      try {
        session = buildSessionFromRow(row);
        sessions.set(sessionId, session);
      } catch (error) {
        diagnostics.errorFromException(
          "Failed to rebuild planning session from store",
          error,
          { sessionId, operation: "start-existing-rebuild" },
        );
      }
    }
  }

  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  // Drafts are sync'd via aiSessionStore.updateDraft, which only writes
  // SQLite. Pull the latest initialPlan + persisted model override + the
  // text the current title was already summarized from. Lets the agent
  // see everything the user typed, lets summarize use the original model,
  // and lets us skip a redundant model call when blur/close already
  // summarized this exact text.
  let persistedProvider: string | undefined;
  let persistedModelId: string | undefined;
  let persistedSummarizedFor: string | undefined;
  let cameFromDraft = false;
  if (_aiSessionStore) {
    const row = _aiSessionStore.get(sessionId);
    if (row) {
      cameFromDraft = row.status === "draft";
      const payload = safeParseJson<DraftInputPayload>(row.inputPayload, {});
      if (payload.initialPlan) {
        session.initialPlan = payload.initialPlan;
      }
      persistedProvider = payload.modelProvider;
      persistedModelId = payload.modelId;
      persistedSummarizedFor = payload.summarizedFor;
    }
  }

  // Re-summarize when transitioning out of draft so the title reflects the
  // FINAL text — but skip the model call when blur/close already produced a
  // summary for this exact text and the user hasn't edited since. Saves
  // tokens when the user blurs the textarea then immediately clicks Start.
  if (cameFromDraft) {
    const trimmed = session.initialPlan.trim();
    const alreadySummarized =
      session.title !== DRAFT_PLACEHOLDER_TITLE && persistedSummarizedFor === trimmed;
    if (!alreadySummarized) {
      const fallback = trimmed.slice(0, 60).trim();
      if (session.title === DRAFT_PLACEHOLDER_TITLE) {
        session.title = fallback || DRAFT_PLACEHOLDER_TITLE;
      }
      const summarizeProvider = modelProvider ?? persistedProvider;
      const summarizeModelId = modelId ?? persistedModelId;
      void (async () => {
        try {
          const generated = await summarizeTitle(trimmed, rootDir, summarizeProvider, summarizeModelId);
          const finalTitle = generated?.trim() || fallback;
          if (!finalTitle) return;
          session.title = finalTitle;
          _aiSessionStore?.updateTitle(sessionId, finalTitle);
        } catch {
          // Keep fallback title
        }
      })();
    }
  }

  persistSession(session, "generating");
  planningStreamManager.registerInitialTurn(sessionId, () => {
    initializeAgent(session, rootDir, store, modelProvider, modelId, promptOverrides).catch((err) => {
      diagnostics.errorFromException("Failed to initialize agent for session", err, { sessionId, operation: "initialize-agent" });
      persistSession(session, "error", err.message || "Failed to initialize AI agent");
      planningStreamManager.broadcast(sessionId, {
        type: "error",
        data: err.message || "Failed to initialize AI agent",
      });
    });
  });
}

/**
 * Create a new planning session with AI agent streaming.
 * This initializes an AI agent that will stream thinking output via SSE.
 * 
 * @param ip - Client IP for rate limiting
 * @param initialPlan - The user's initial plan description
 * @param rootDir - Project root directory for AI agent context
 * @param modelProvider - Optional AI model provider override
 * @param modelId - Optional AI model ID override
 * @param promptOverrides - Optional prompt override map for system prompt customization
 * @returns Session ID (use with planningStreamManager to receive events)
 */
export async function createSessionWithAgent(
  ip: string,
  initialPlan: string,
  rootDir: string,
  store: TaskStore,
  modelProvider?: string,
  modelId?: string,
  promptOverrides?: PromptOverrideMap,
  options?: {
    projectId?: string;
    ntfyConfig?: PlanningNtfyConfig;
    planningDepth?: PlanningDepth;
    customQuestionCount?: number;
  },
): Promise<string> {
  // Check rate limit
  if (!checkRateLimit(ip)) {
    const resetTime = getRateLimitResetTime(ip);
    throw new RateLimitError(
      `Rate limit exceeded. Maximum ${MAX_SESSIONS_PER_IP_PER_HOUR} planning sessions per hour. ` +
        `Reset at ${resetTime?.toISOString() || "unknown"}`
    );
  }

  const sessionId = randomUUID();

  const session: Session = {
    id: sessionId,
    ip,
    initialPlan,
    title: initialPlan.slice(0, 120),
    projectId: options?.projectId,
    ntfyConfig: options?.ntfyConfig
      ? {
          enabled: options.ntfyConfig.enabled,
          topic: options.ntfyConfig.topic,
          dashboardHost: options.ntfyConfig.dashboardHost,
          events: options.ntfyConfig.events ? [...options.ntfyConfig.events] : undefined,
          ntfyBaseUrl: options.ntfyConfig.ntfyBaseUrl,
        }
      : undefined,
    history: [],
    thinkingOutput: "",
    lastGeneratedThinking: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  sessions.set(sessionId, session);
  persistSession(session, "generating");

  planningStreamManager.registerInitialTurn(sessionId, () => {
    initializeAgent(
      session,
      rootDir,
      store,
      modelProvider,
      modelId,
      promptOverrides,
      options?.planningDepth,
      options?.customQuestionCount,
    ).catch((err) => {
      diagnostics.errorFromException("Failed to initialize agent for session", err, { sessionId, operation: "initialize-agent" });
      persistSession(session, "error", err.message || "Failed to initialize AI agent");
      planningStreamManager.broadcast(sessionId, {
        type: "error",
        data: err.message || "Failed to initialize AI agent",
      });
    });
  });

  return sessionId;
}

/**
 * Initialize the AI agent for a session and start the first turn.
 */
async function initializeAgent(
  session: Session,
  rootDir: string,
  store: TaskStore,
  modelProvider?: string,
  modelId?: string,
  promptOverrides?: PromptOverrideMap,
  planningDepth?: PlanningDepth,
  customQuestionCount?: number,
): Promise<void> {
  try {
    await runGenerationWithTimeout(session, async (abortSignal) => {
      /*
      FNXC:PlanningSession 2026-06-16-20:23:
      FN-6511 requires planning agent construction to be bounded before the first prompt starts. Keep createFnAgent inside the active generation timeout so model-registry or extension-discovery stalls transition the SSE session to a terminal error instead of leaving it pinned in generating.
      */
      const agentPromise = createPlanningAgent(
        session,
        rootDir,
        store,
        modelProvider,
        modelId,
        promptOverrides,
        planningDepth,
        customQuestionCount,
      );

      void agentPromise.then((lateAgent) => {
        if (abortSignal.aborted) {
          nonfatal(
            () => lateAgent?.session?.dispose?.(),
            diagnostics,
            "Error disposing late-created planning agent",
            { sessionId: session.id, operation: "dispose-late-agent" },
          );
        }
      }, () => undefined);

      const agent = await agentPromise;
      if (abortSignal.aborted) {
        nonfatal(
          () => agent?.session?.dispose?.(),
          diagnostics,
          "Error disposing aborted planning agent",
          { sessionId: session.id, operation: "dispose-aborted-agent" },
        );
        throw createAbortError();
      }
      session.agent = agent;
      session.updatedAt = new Date();
    });

    // Send initial message to get first question
    await continueAgentConversation(session, session.initialPlan);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return;
    }

    const errorMessage = err instanceof Error ? err.message : "Failed to initialize AI agent";
    diagnostics.errorFromException("Agent initialization error for session", err, { sessionId: session.id, operation: "initialize-agent" });
    session.error = errorMessage;
    session.updatedAt = new Date();
    persistSession(session, "error", errorMessage);
    planningStreamManager.broadcast(session.id, {
      type: "error",
      data: errorMessage,
    });
  }
}

async function createPlanningAgent(
  session: Session,
  rootDir: string,
  store: TaskStore,
  modelProvider?: string,
  modelId?: string,
  promptOverrides?: PromptOverrideMap,
  planningDepth?: PlanningDepth,
  customQuestionCount?: number,
): Promise<AgentResult> {
  // Ensure engine is loaded before using createFnAgent
  await ensureEngineReady();

  // Resolve the effective system prompt (override or default)
  const baseSystemPrompt = resolvePrompt("planning-system", promptOverrides) || PLANNING_SYSTEM_PROMPT;
  const depthPromptSuffix = buildDepthPromptSuffix(planningDepth, customQuestionCount);
  const systemPrompt = depthPromptSuffix ? `${baseSystemPrompt}\n\n${depthPromptSuffix}` : baseSystemPrompt;

  return createFnAgent({
    cwd: rootDir,
    systemPrompt,
    tools: "readonly",
    builtinToolsAllowlist: [...PLANNING_BUILTIN_WEB_TOOLS],
    customTools: [
      ...createPlanningBoardTools(store),
      ...createWorkflowAuthoringTools(store, PLANNING_NO_AMBIENT_TASK_ID, { stripApprovalFlags: true }),
    ],
    ...(modelProvider && modelId
      ? {
          defaultProvider: modelProvider,
          defaultModelId: modelId,
        }
      : {}),
    onThinking: (delta: string) => {
      session.thinkingOutput += delta;
      persistThinking(session.id, session.thinkingOutput);
      planningStreamManager.broadcast(session.id, {
        type: "thinking",
        data: delta,
      });
    },
    onText: (delta: string) => {
      // Capture AI response text — will be parsed at end of turn. Also
      // surface it through the same stream so non-thinking models (which
      // never emit thinking_delta) still show streaming output in the UI.
      session.thinkingOutput += delta;
      persistThinking(session.id, session.thinkingOutput);
      planningStreamManager.broadcast(session.id, {
        type: "thinking",
        data: delta,
      });
    },
  });
}

function buildHistoryReplayPrompt(
  history: Array<{ question: PlanningQuestion; response: unknown }>,
): string {
  const interviewSummary = formatInterviewQA(history);
  if (!interviewSummary) {
    return "No prior planning interview context is available.";
  }

  return [
    "Previous conversation summary:",
    interviewSummary,
    "Use this as context for the next response. Do not repeat prior questions unless necessary.",
  ].join("\n\n");
}

async function ensureSessionAgent(
  session: Session,
  rootDir: string | undefined,
  historyForReplay: Array<{ question: PlanningQuestion; response: unknown }>,
  promptOverrides?: PromptOverrideMap,
  store?: TaskStore,
): Promise<void> {
  if (session.agent) {
    return;
  }

  // Fall back to session-captured context for rehydrated sessions whose
  // submitResponse/retry/rewind call sites don't plumb rootDir/store.
  const effectiveRootDir = rootDir ?? session.rootDir;
  const effectiveStore = store ?? session.store;

  if (!effectiveRootDir) {
    throw new InvalidSessionStateError(
      "Planning session has no AI agent and cannot be resumed without project context",
    );
  }

  if (!effectiveStore) {
    throw new InvalidSessionStateError(
      "Planning session has no task store and cannot be resumed without project context",
    );
  }

  session.agent = await createPlanningAgent(session, effectiveRootDir, effectiveStore, undefined, undefined, promptOverrides);

  if (historyForReplay.length === 0) {
    return;
  }

  const contextMessage = buildHistoryReplayPrompt(historyForReplay);
  await session.agent.session.prompt(contextMessage);
}

async function maybeNotifyPlanningAwaitingInput(session: Session, question: PlanningQuestion): Promise<void> {
  const config = session.ntfyConfig;
  if (!config?.enabled || !config.topic) {
    return;
  }

  await ensureNtfyHelpersReady();
  const eventEnabled = planningNtfyHelpers?.isNtfyEventEnabled
    ? planningNtfyHelpers.isNtfyEventEnabled(config.events, "planning-awaiting-input")
    : (config.events ? config.events.includes("planning-awaiting-input") : true);
  if (!eventEnabled) {
    return;
  }

  const questionKey = `${session.id}:${question.id}`;
  if (session.lastNotifiedQuestionKey === questionKey) {
    return;
  }
  session.lastNotifiedQuestionKey = questionKey;

  if (!planningNtfyHelpers) {
    return;
  }

  try {
    const clickUrl = planningNtfyHelpers.buildNtfyClickUrl({
      dashboardHost: config.dashboardHost,
      projectId: session.projectId,
    });
    await planningNtfyHelpers.sendNtfyNotification({
      ntfyBaseUrl: config.ntfyBaseUrl,
      topic: config.topic,
      title: "Planning needs your input",
      message: `Planning mode is waiting for input: ${question.question}`,
      priority: "high",
      clickUrl,
    });
  } catch (error) {
    diagnostics.warn("Failed to deliver planning awaiting-input ntfy notification", {
      sessionId: session.id,
      questionId: question.id,
      error: error instanceof Error ? error.message : String(error),
      operation: "planning-notify-awaiting-input",
    });
  }
}

/** Max number of retry attempts when AI returns unparseable output */
const MAX_PARSE_RETRIES = 1;

/**
 * Continue the AI conversation with a user message.
 *
 * Includes a bounded recovery path: if the AI response cannot be parsed,
 * one retry attempt is made with a reformat prompt before emitting a
 * terminal session error.
 */
function setSessionError(session: Session, message: string): void {
  session.error = message;
  session.updatedAt = new Date();
  persistSession(session, "error", message);
  planningStreamManager.broadcast(session.id, {
    type: "error",
    data: message,
  });
}

function createAbortError(): Error {
  const error = new Error("Generation aborted");
  error.name = "AbortError";
  return error;
}

async function runGenerationWithTimeout<T>(session: Session, operation: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
  const existing = activeGenerations.get(session.id);
  if (existing) {
    clearTimeout(existing.timer);
    existing.abortController.abort();
  }

  const abortController = new AbortController();
  let timeoutTriggered = false;
  const timer = setTimeout(() => {
    timeoutTriggered = true;
    setSessionError(session, "AI generation timed out. You can retry or start a new session.");
    disposeSessionAgentForRetry(session);
    abortController.abort();
  }, GENERATION_TIMEOUT_MS);
  const generationRecord = { abortController, timer };

  activeGenerations.set(session.id, generationRecord);

  const abortPromise = new Promise<never>((_, reject) => {
    abortController.signal.addEventListener(
      "abort",
      () => reject(createAbortError()),
      { once: true },
    );
  });

  try {
    return await Promise.race([operation(abortController.signal), abortPromise]);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (!timeoutTriggered && !session.error) {
        setSessionError(session, "Generation stopped by user. You can retry or start a new session.");
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (activeGenerations.get(session.id) === generationRecord) {
      activeGenerations.delete(session.id);
    }
  }
}

async function continueAgentConversation(session: Session, message: string): Promise<void> {
  if (!session.agent) {
    throw new InvalidSessionStateError("AI agent not initialized");
  }

  try {
    await runGenerationWithTimeout(session, async (abortSignal) => {
      // Clear thinking output for this turn
      session.thinkingOutput = "";

      // Send message to agent using .prompt() - it will stream thinking via onThinking callback.
      // Pass abort signal so timeout/user-stop can cancel the underlying prompt when supported.
      await (session.agent.session.prompt as (input: string, options?: { signal?: AbortSignal }) => Promise<void>)(message, {
        signal: abortSignal,
      });

    // Get the response text from the agent's state
    interface AgentMessage {
      role: string;
      content?: string | Array<{ type: string; text: string }>;
    }
    const lastMessage = (session.agent.session.state.messages as AgentMessage[])
      .filter((m: AgentMessage) => m.role === "assistant")
      .pop();
    
    let responseText = session.thinkingOutput;
    if (lastMessage?.content) {
      // Handle both string and array content types
      if (typeof lastMessage.content === "string") {
        responseText = lastMessage.content;
      } else if (Array.isArray(lastMessage.content)) {
        // Extract text from content blocks; only overwrite fallback if non-empty
        const extracted = lastMessage.content
          .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { type: string; text: string }) => c.text)
          .join("");
        if (extracted) {
          responseText = extracted;
        }
      }
    }

    // Diagnostic: warn when response text is empty or very short
    if (!responseText || responseText.length < 10) {
      const contentBlockTypes = Array.isArray(lastMessage?.content)
        ? lastMessage.content.map((c: { type: string }) => c.type)
        : typeof lastMessage?.content === "string" ? ["string"] : [];
      diagnostics.warn(
        "Response text is empty or very short before parse",
        {
          sessionId: session.id,
          responseTextLength: responseText.length,
          contentBlockTypes,
          usedThinkingOutputFallback: responseText === session.thinkingOutput,
          operation: "response-extraction",
        }
      );
    }

    // Parse the JSON response with retry
    let parsed: PlanningResponse | undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
      try {
        parsed = parseAgentResponse(responseText);
        break; // success
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        
        if (attempt < MAX_PARSE_RETRIES) {
          // Retry: ask the AI to reformat as clean JSON
          diagnostics.warn(
            "Parse attempt failed, requesting reformat",
            { sessionId: session.id, attempt: attempt + 1, operation: "parse-retry" }
          );
          try {
            session.thinkingOutput = "";
            await (session.agent.session.prompt as (input: string, options?: { signal?: AbortSignal }) => Promise<void>)(
              "Your previous response could not be parsed as JSON. " +
                'Please respond with ONLY a valid JSON object: either {"type":"question","data":{...}} ' +
                'or {"type":"complete","data":{...}}. No markdown, no explanation, just the JSON.',
              { signal: abortSignal },
            );
            
            // Get the new response text
            const retryMessage = (session.agent.session.state.messages as AgentMessage[])
              .filter((m: AgentMessage) => m.role === "assistant")
              .pop();
            
            let retryText = session.thinkingOutput;
            if (retryMessage?.content) {
              if (typeof retryMessage.content === "string") {
                retryText = retryMessage.content;
              } else if (Array.isArray(retryMessage.content)) {
                const extracted = retryMessage.content
                  .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
                  .map((c: { type: string; text: string }) => c.text)
                  .join("");
                if (extracted) {
                  retryText = extracted;
                }
              }
            }
            responseText = retryText;
          } catch (retryErr) {
            // Retry prompt itself failed — give up
            diagnostics.errorFromException(
              "Retry prompt failed for session",
              retryErr,
              { sessionId: session.id, operation: "retry-prompt" }
            );
            break;
          }
        }
      }
    }

    if (!parsed) {
      // All attempts exhausted — emit actionable error
      const errorMsg = `${lastError?.message || "Failed to parse AI response"} You can try responding again or start a new planning session.`;
      diagnostics.error(
        "All parse attempts exhausted for session",
        { sessionId: session.id, message: errorMsg, operation: "parse-exhausted" }
      );
      session.error = errorMsg;
      session.updatedAt = new Date();
      persistSession(session, "error", errorMsg);
      planningStreamManager.broadcast(session.id, {
        type: "error",
        data: errorMsg,
      });
      return;
    }

      if (parsed.type === "question") {
        session.currentQuestion = parsed.data;
        session.summary = undefined;
        session.error = undefined;
        session.lastGeneratedThinking = session.thinkingOutput;
        session.updatedAt = new Date();
        persistSession(session, "awaiting_input");
        void maybeNotifyPlanningAwaitingInput(session, parsed.data);
        planningStreamManager.broadcast(session.id, {
          type: "question",
          data: parsed.data,
        });
      } else if (parsed.type === "complete") {
        session.summary = parsed.data;
        session.currentQuestion = undefined;
        session.error = undefined;
        session.updatedAt = new Date();
        persistSession(session, "complete");
        planningStreamManager.broadcast(session.id, {
          type: "summary",
          data: parsed.data,
        });
        planningStreamManager.broadcast(session.id, { type: "complete" });
      }
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return;
    }

    const errorMessage = err instanceof Error ? err.message : "AI processing failed";
    diagnostics.errorFromException("Agent conversation error for session", err, { sessionId: session.id, operation: "conversation" });
    setSessionError(session, errorMessage);
  }
}

/**
 * Extract the best JSON candidate from AI response text.
 *
 * Handles:
 * - Markdown-wrapped JSON (```json ... ```)
 * - JSON embedded in leading/trailing prose
 * - Multiple JSON objects (picks the largest balanced one)
 *
 * Returns the extracted JSON string or null if nothing usable is found.
 */
function extractJsonCandidate(text: string): string | null {
  if (!text || !text.trim()) return null;

  // 1. Try markdown code blocks first (most reliable)
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    const candidate = codeBlockMatch[1].trim();
    if (candidate.startsWith("{")) return candidate;
  }

  // 2. Find all top-level brace-delimited objects using balanced brace counting
  const candidates: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === "{") depth++;
        if (ch === "}") depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1).trim();
          // Only accept candidates that parse as valid JSON
          try {
            JSON.parse(candidate);
            candidates.push({ start: i, end: j, text: candidate });
          } catch {
            // Not valid JSON, skip
          }
          break;
        }
      }
    }
  }

  // Pick the largest valid candidate (most likely the full response)
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.text.length - a.text.length);
    return candidates[0].text;
  }

  // 3. Last resort: try the full trimmed text
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;

  return null;
}

/**
 * Attempt to repair common JSON issues:
 * - Truncated JSON (missing closing braces)
 * - Trailing commas before closing braces
 * - Missing closing quotes
 *
 * Returns the repaired string, or the original if no repair was possible.
 */
function repairJson(text: string): string {
  let repaired = text;

  // Fix trailing commas before } or ]
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");

  // Count open/close braces and brackets
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of repaired) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") openBraces++;
    if (ch === "}") openBraces--;
    if (ch === "[") openBrackets++;
    if (ch === "]") openBrackets--;
  }

  // If we're in an unclosed string, close it
  if (inString) {
    repaired += '"';
  }

  // Re-count after potential string fix
  openBraces = 0;
  openBrackets = 0;
  inString = false;
  escape = false;
  for (const ch of repaired) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") openBraces++;
    if (ch === "}") openBraces--;
    if (ch === "[") openBrackets++;
    if (ch === "]") openBrackets--;
  }

  // Close unclosed brackets and braces
  repaired += "]".repeat(Math.max(0, openBrackets));
  repaired += "}".repeat(Math.max(0, openBraces));

  return repaired;
}

/**
 * Parse agent response JSON with robust extraction and recovery.
 *
 * Strategy:
 * 1. Extract JSON candidate from text (handles markdown wrapping, prose)
 * 2. Try parsing directly
 * 3. If parse fails, attempt repair (truncated JSON, trailing commas)
 * 4. Validate the resulting structure
 */
export function parseAgentResponse(text: string): PlanningResponse {
  const candidate = extractJsonCandidate(text);

  if (!candidate) {
    diagnostics.error("No JSON candidate found in agent response", { inputSnippet: text.slice(0, 500), operation: "parse-json" });
    throw new Error("AI returned no valid JSON. Please try again.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Attempt repair for truncated/malformed JSON
    try {
      const repaired = repairJson(candidate);
      parsed = JSON.parse(repaired);
    } catch (repairErr) {
      diagnostics.error(
        "Failed to parse agent response (repair also failed)",
        { inputSnippet: candidate.slice(0, 500), operation: "parse-json-repair" }
      );
      throw new Error(
        `Failed to parse AI response: ${repairErr instanceof Error ? repairErr.message : "Unknown error"}. Please try again.`
      );
    }
  }

  // Validate structure
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    "data" in parsed
  ) {
    const typed = parsed as { type: string; data: unknown };
    if (
      (typed.type === "question" || typed.type === "complete") &&
      typed.data !== null &&
      typed.data !== undefined
    ) {
      return parsed as PlanningResponse;
    }
  }

  diagnostics.error("Invalid response structure from AI", { parsedSnippet: JSON.stringify(parsed).slice(0, 500), operation: "parse-validate" });
  throw new Error("AI returned an invalid response structure. Please try again.");
}

/**
 * Submit a response to the current question and get the next question or summary.
 * Supports both stubbed mode and AI agent mode.
 */
function isRefineRequest(responses: Record<string, unknown>): boolean {
  return responses.refine === true;
}

function formatRefineRequestForAgent(summary: PlanningSummary): string {
  return [
    "The user clicked Refine Further on the planning summary.",
    "Continue the planning interview from the existing context.",
    "Either ask one focused follow-up question or return an updated completion summary if sufficient.",
    "Current summary:",
    JSON.stringify(summary),
  ].join("\n\n");
}

function didSubmitSameAnswer(
  session: Session,
  responses: Record<string, unknown>,
): boolean {
  if (!session.currentQuestion) {
    return false;
  }
  const lastEntry = session.history[session.history.length - 1];
  if (!lastEntry || lastEntry.question.id !== session.currentQuestion.id) {
    return false;
  }
  return JSON.stringify(lastEntry.response) === JSON.stringify(responses);
}

export async function submitResponse(
  sessionId: string,
  responses: Record<string, unknown>,
  rootDir?: string,
  promptOverrides?: PromptOverrideMap,
  store?: TaskStore,
): Promise<PlanningResponse> {
  const session = getSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  // Stash store/rootDir on the session so subsequent ensureSessionAgent calls
  // (after the agent is disposed for retry/rewind) can rebuild without the
  // caller having to thread context through every API.
  if (store && !session.store) session.store = store;
  if (rootDir && !session.rootDir) session.rootDir = rootDir;

  if (activeGenerations.has(session.id)) {
    if (didSubmitSameAnswer(session, responses)) {
      throw new GenerationInProgressError("Generation already in progress for this response");
    }
    throw new GenerationInProgressError("Generation already in progress");
  }

  if (!session.currentQuestion) {
    if (!isRefineRequest(responses) || !session.summary) {
      throw new InvalidSessionStateError("No active question in session");
    }

    session.error = undefined;
    persistSession(session, "generating");

    await ensureSessionAgent(session, rootDir, session.history, promptOverrides, store);
    const refineMessage = formatRefineRequestForAgent(session.summary);
    await continueAgentConversation(session, refineMessage);
  } else {
    const currentQuestion = session.currentQuestion;
    const historyEntry = {
      question: currentQuestion,
      response: responses,
      thinkingOutput: session.lastGeneratedThinking || "",
    };

    session.error = undefined;
    /*
    FNXC:DashboardSessionPersistence 2026-06-14-09:09:
    Persist the user's answered planning turn before the agent generates the next question or errors. AiSessionStore snapshots happen inside continueAgentConversation, so history must already include the submitted answer for retry replay and SQLite round-trip tests to observe durable state.
    */
    session.history.push(historyEntry);
    persistSession(session, "generating");

    if (!session.agent) {
      await ensureSessionAgent(session, rootDir, session.history.slice(0, -1), promptOverrides, store);
    }

    const message = formatResponseForAgent(currentQuestion, responses);
    await continueAgentConversation(session, message);
  }

  // Return the current state (will be updated via SSE)
  if (session.summary) {
    return { type: "complete", data: session.summary };
  }
  if (session.currentQuestion) {
    return { type: "question", data: session.currentQuestion };
  }

  // Should not reach here, but handle gracefully
  throw new InvalidSessionStateError("AI agent did not return a question or summary");
}

export async function retrySession(
  sessionId: string,
  rootDir: string,
  promptOverrides?: PromptOverrideMap,
  store?: TaskStore,
): Promise<void> {
  const session = getSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  if (store && !session.store) session.store = store;
  if (rootDir && !session.rootDir) session.rootDir = rootDir;

  const persisted = _aiSessionStore?.get(sessionId);
  if (persisted && persisted.type !== "planning") {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  const inErrorState = persisted ? persisted.status === "error" : Boolean(session.error);
  if (!inErrorState) {
    throw new InvalidSessionStateError(`Planning session ${sessionId} is not in an error state`);
  }

  disposeSessionAgentForRetry(session);

  session.error = undefined;
  session.summary = undefined;
  session.updatedAt = new Date();
  persistSession(session, "generating");

  if (session.history.length === 0) {
    await ensureSessionAgent(session, rootDir, [], promptOverrides, store);
    await continueAgentConversation(session, session.initialPlan);
    return;
  }

  const replayHistory = session.history.slice(0, -1);
  const lastEntry = session.history[session.history.length - 1];

  await ensureSessionAgent(session, rootDir, replayHistory, promptOverrides, store);
  const replayMessage = formatResponseForAgent(
    lastEntry.question,
    coerceResponseRecord(lastEntry.question, lastEntry.response),
  );
  await continueAgentConversation(session, replayMessage);
}

export interface PlanningRewindResult {
  currentQuestion: PlanningQuestion;
  history: PlanningHistoryEntry[];
}

export async function rewindSession(
  sessionId: string,
  rootDir?: string,
  promptOverrides?: PromptOverrideMap,
  store?: TaskStore,
): Promise<PlanningRewindResult> {
  const session = getSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  if (store && !session.store) session.store = store;
  if (rootDir && !session.rootDir) session.rootDir = rootDir;

  if (session.history.length === 0) {
    throw new InvalidSessionStateError("Planning session has no previous question to rewind to");
  }

  const rewindEntry = session.history.pop();
  if (!rewindEntry) {
    throw new InvalidSessionStateError("Planning session has no previous question to rewind to");
  }

  disposeSessionAgentForRetry(session);

  session.currentQuestion = rewindEntry.question;
  session.summary = undefined;
  session.error = undefined;
  session.lastGeneratedThinking = session.history[session.history.length - 1]?.thinkingOutput ?? "";
  session.thinkingOutput = "";
  session.updatedAt = new Date();

  if (!session.agent && rootDir) {
    await ensureSessionAgent(session, rootDir, session.history, promptOverrides, store);
  }

  persistSession(session, "awaiting_input");
  planningStreamManager.broadcast(session.id, { type: "question", data: rewindEntry.question });

  return {
    currentQuestion: rewindEntry.question,
    history: [...session.history],
  };
}

export function stopGeneration(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  const activeGeneration = activeGenerations.get(sessionId);

  if (!session || !activeGeneration) {
    return false;
  }

  activeGeneration.abortController.abort();
  clearTimeout(activeGeneration.timer);
  activeGenerations.delete(sessionId);

  if (session.agent) {
    nonfatal(
      () => session.agent?.session.dispose?.(),
      diagnostics,
      "Error disposing agent for stop-generation",
      { sessionId, operation: "stop-generation-dispose" },
    );
    session.agent = undefined;
  }

  setSessionError(session, "Generation stopped by user. You can retry or start a new session.");
  return true;
}

/**
 * Format user response as a message for the AI agent.
 */
function formatResponseForAgent(
  question: PlanningQuestion,
  responses: Record<string, unknown>
): string {
  const responseValue = responses[question.id];
  const comment = typeof responses._comment === "string" ? responses._comment.trim() : "";

  let formatted: string;

  switch (question.type) {
    case "text":
      formatted = `Question: ${question.question}\n\nAnswer: ${responseValue}`;
      break;

    case "single_select":
      if (typeof responseValue === "string") {
        const option = question.options?.find((o) => o.id === responseValue);
        formatted = `Question: ${question.question}\n\nSelected: ${option?.label || responseValue}`;
        break;
      }
      formatted = `Question: ${question.question}\n\nAnswer: ${responseValue}`;
      break;

    case "multi_select":
      if (Array.isArray(responseValue)) {
        const selected = responseValue.map((id) => {
          const option = question.options?.find((o) => o.id === id);
          return option?.label || id;
        });
        formatted = `Question: ${question.question}\n\nSelected: ${selected.join(", ")}`;
        break;
      }
      formatted = `Question: ${question.question}\n\nAnswer: ${responseValue}`;
      break;

    case "confirm":
      formatted = `Question: ${question.question}\n\nAnswer: ${responseValue === true ? "Yes" : "No"}`;
      break;

    default:
      formatted = `Question: ${question.question}\n\nAnswer: ${JSON.stringify(responseValue)}`;
      break;
  }

  return comment.length > 0 ? `${formatted}\n\nAdditional context: ${comment}` : formatted;
}

function coerceResponseRecord(question: PlanningQuestion, response: unknown): Record<string, unknown> {
  if (response && typeof response === "object" && !Array.isArray(response)) {
    return response as Record<string, unknown>;
  }

  return {
    [question.id]: response,
  };
}

function disposeSessionAgentForRetry(session: Session): void {
  if (!session.agent) {
    return;
  }

  nonfatal(
    () => session.agent.session.dispose?.(),
    diagnostics,
    "Error disposing agent for retry",
    { sessionId: session.id, operation: "dispose-retry" }
  );

  session.agent = undefined;
}

function formatInterviewAnswer(question: PlanningQuestion, responseValue: unknown): string {
  switch (question.type) {
    case "text":
      return typeof responseValue === "string" ? responseValue : String(responseValue ?? "");

    case "single_select":
      if (typeof responseValue === "string") {
        const option = question.options?.find((candidate) => candidate.id === responseValue);
        return option?.label || responseValue;
      }
      return String(responseValue ?? "");

    case "multi_select":
      if (Array.isArray(responseValue)) {
        const selected = responseValue.map((id) => {
          if (typeof id !== "string") {
            return String(id);
          }
          const option = question.options?.find((candidate) => candidate.id === id);
          return option?.label || id;
        });
        return selected.join(", ");
      }
      return String(responseValue ?? "");

    case "confirm":
      return responseValue === true ? "Yes" : "No";

    default:
      return JSON.stringify(responseValue);
  }
}

/**
 * Format planning interview Q&A history for task descriptions and logs.
 */
export function formatInterviewQA(
  history: Array<{ question: PlanningQuestion; response: unknown }>
): string {
  if (history.length === 0) {
    return "";
  }

  const entries = history.map(({ question, response }) => {
    const responseRecord =
      response && typeof response === "object" && !Array.isArray(response)
        ? (response as Record<string, unknown>)
        : undefined;
    const responseValue = responseRecord ? responseRecord[question.id] : response;
    const comment = typeof responseRecord?._comment === "string" ? responseRecord._comment.trim() : "";

    const answerLine = `**Q: ${question.question}**\nA: ${formatInterviewAnswer(question, responseValue)}`;
    return comment.length > 0 ? `${answerLine}\nComment: ${comment}` : answerLine;
  });

  return `## Planning Interview Context\n\n${entries.join("\n\n")}`;
}

/**
 * Cancel and cleanup a planning session.
 */
export async function cancelSession(sessionId: string): Promise<void> {
  const removed = cleanupInMemorySession(sessionId);
  if (!removed) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  unpersistSession(sessionId);
}

/**
 * Get session details.
 */
export function getSession(sessionId: string): Session | undefined {
  const inMemory = sessions.get(sessionId);
  if (inMemory) {
    return inMemory;
  }

  if (!_aiSessionStore) {
    return undefined;
  }

  const row = _aiSessionStore.get(sessionId);
  if (!row || row.type !== "planning") {
    return undefined;
  }

  try {
    const restored = buildSessionFromRow(row);
    sessions.set(restored.id, restored);
    return restored;
  } catch (error) {
    diagnostics.errorFromException("Failed to restore session from SQLite", error, { sessionId, operation: "restore" });
    return undefined;
  }
}

/**
 * Get the current question for a session.
 */
export function getCurrentQuestion(sessionId: string): PlanningQuestion | undefined {
  return sessions.get(sessionId)?.currentQuestion;
}

/**
 * Get the summary for a completed session.
 */
export function getSummary(sessionId: string): PlanningSummary | undefined {
  return sessions.get(sessionId)?.summary;
}

/**
 * Generate subtasks from a completed planning summary.
 * Uses the planning session's summary to create a SubtaskItem[] for multi-task creation.
 * Always appends a final end-to-end verification subtask, regardless of deliverable count.
 *
 * @param sessionId - The planning session ID
 * @returns Array of SubtaskItem with titles derived from keyDeliverables, or fallback
 */
function buildPlanningSubtaskDescription(input: {
  taskGuidance: string;
  summaryDescription: string;
  qaSection: string;
}): string {
  const contextSections = [
    "## Larger Plan Context",
    input.summaryDescription,
  ];

  if (input.qaSection) {
    contextSections.push(input.qaSection);
  }

  return `${input.taskGuidance}\n\n${contextSections.join("\n\n")}`;
}

export interface PlanningSubtaskDraft {
  id: string;
  title?: string;
  description?: string;
  suggestedSize?: "S" | "M" | "L";
  priority?: TaskPriority;
  dependsOn?: string[];
}

/**
 * Generate planning subtasks from a completed planning summary.
 * Always appends a final end-to-end verification subtask, regardless of deliverable count.
 */
export function generateSubtasksFromPlanning(sessionId: string): SubtaskItem[] {
  const session = sessions.get(sessionId);
  if (!session) return [];
  if (!session.summary) return [];

  const { summary } = session;
  const qaSection = formatInterviewQA(session.history);

  // If key deliverables exist, create one subtask per deliverable plus a final verification subtask.
  if (summary.keyDeliverables.length > 0) {
    const deliverableSubtasks = summary.keyDeliverables.map((deliverable, index) => {
      const id = `subtask-${index + 1}`;
      const dependsOn = index > 0 ? [`subtask-${index}`] : [] as string[];
      return {
        id,
        title: deliverable,
        description: buildPlanningSubtaskDescription({
          taskGuidance: `Implement "${deliverable}" as this subtask's primary outcome. Focus only on the concrete changes needed to deliver this item.`,
          summaryDescription: summary.description,
          qaSection,
        }),
        suggestedSize: index === 0 ? "S" as const : index === summary.keyDeliverables.length - 1 ? "S" as const : "M" as const,
        priority: summary.priority ?? DEFAULT_TASK_PRIORITY,
        dependsOn,
      };
    });

    deliverableSubtasks.push({
      id: `subtask-${summary.keyDeliverables.length + 1}`,
      title: "Verify end-to-end",
      description: buildPlanningSubtaskDescription({
        taskGuidance: "Verify the full plan end-to-end now that all deliverables are implemented. Exercise the integrated behavior described in the plan, confirm acceptance criteria hold, run the project test suite, and capture any follow-ups as new tasks rather than expanding scope.",
        summaryDescription: summary.description,
        qaSection,
      }),
      suggestedSize: "S",
      priority: summary.priority ?? DEFAULT_TASK_PRIORITY,
      dependsOn: [`subtask-${summary.keyDeliverables.length}`],
    });

    return deliverableSubtasks;
  }

  // Fallback: 3 subtasks
  return [
    {
      id: "subtask-1",
      title: "Define implementation approach",
      description: buildPlanningSubtaskDescription({
        taskGuidance: "Define the implementation approach for the plan, including architecture and sequencing decisions needed before coding.",
        summaryDescription: summary.description,
        qaSection,
      }),
      suggestedSize: "S" as const,
      priority: summary.priority ?? DEFAULT_TASK_PRIORITY,
      dependsOn: [],
    },
    {
      id: "subtask-2",
      title: "Implement core changes",
      description: buildPlanningSubtaskDescription({
        taskGuidance: "Implement the core code changes described by the plan, using the agreed approach from the prior subtask.",
        summaryDescription: summary.description,
        qaSection,
      }),
      suggestedSize: "M" as const,
      priority: summary.priority ?? DEFAULT_TASK_PRIORITY,
      dependsOn: ["subtask-1"],
    },
    {
      id: "subtask-3",
      title: "Verify and polish",
      description: buildPlanningSubtaskDescription({
        taskGuidance: "Verify the implementation end-to-end, then polish quality items like tests, docs, and edge-case handling before closing out the plan.",
        summaryDescription: summary.description,
        qaSection,
      }),
      suggestedSize: "S" as const,
      priority: summary.priority ?? DEFAULT_TASK_PRIORITY,
      dependsOn: ["subtask-2"],
    },
  ];
}

export function mergePlanningSubtaskDrafts(
  sessionId: string,
  drafts: PlanningSubtaskDraft[],
): SubtaskItem[] {
  const generatedSubtasks = generateSubtasksFromPlanning(sessionId);
  const generatedById = new Map(generatedSubtasks.map((subtask) => [subtask.id, subtask]));

  return drafts.map((draft) => {
    const generated = generatedById.get(draft.id);
    const normalizedDependsOn = Array.isArray(draft.dependsOn)
      ? draft.dependsOn.filter((dependency): dependency is string => typeof dependency === "string")
      : undefined;

    if (!generated) {
      const title = typeof draft.title === "string" ? draft.title.trim() : "";
      if (!title) {
        throw new Error(`Client-added subtask must have a title: ${draft.id}`);
      }

      const description = typeof draft.description === "string" ? draft.description : title;
      return {
        id: draft.id,
        title,
        description,
        suggestedSize: draft.suggestedSize === "S" || draft.suggestedSize === "M" || draft.suggestedSize === "L"
          ? draft.suggestedSize
          : "M",
        priority: draft.priority ?? DEFAULT_TASK_PRIORITY,
        dependsOn: normalizedDependsOn ?? [],
      };
    }

    return {
      id: generated.id,
      title: typeof draft.title === "string" ? draft.title : generated.title,
      description: typeof draft.description === "string" ? draft.description : generated.description,
      suggestedSize: draft.suggestedSize === "S" || draft.suggestedSize === "M" || draft.suggestedSize === "L"
        ? draft.suggestedSize
        : generated.suggestedSize,
      priority: draft.priority ?? generated.priority ?? DEFAULT_TASK_PRIORITY,
      dependsOn: normalizedDependsOn ?? generated.dependsOn,
    };
  });
}

/**
 * Cleanup a session and remove its persisted row.
 */
export function cleanupSession(sessionId: string): void {
  cleanupInMemorySession(sessionId);
  unpersistSession(sessionId);
}

/**
 * Reset all planning state. Used for testing only.
 */
export function __resetPlanningState(): void {
  // Cleanup all agent sessions
  for (const [id] of sessions) {
    cleanupInMemorySession(id);
  }
  sessions.clear();
  rateLimits.clear();
  planningStreamManager.reset();
  activeGenerations.clear();

  if (_aiSessionStore && _aiSessionDeletedListener) {
    _aiSessionStore.off("ai_session:deleted", _aiSessionDeletedListener);
  }
  _aiSessionDeletedListener = undefined;
  _aiSessionStore = undefined;

  planningNtfyHelpers = undefined;

  // Reset diagnostics sink to default
  resetDiagnosticsSink();
}

/**
 * Inject a mock createFnAgent function. Used for testing only.
 */
export function __setCreateFnAgent(mock: typeof createFnAgent): void {
  createFnAgent = mock;
}

/** Inject ntfy helper implementations (test-only). */
export function __setPlanningNtfyHelpers(mock: PlanningNtfyHelpers | undefined): void {
  planningNtfyHelpers = mock;
}

/** Test-only helper for validating generation tracking behavior. */
export function __getActiveGenerationForTests(sessionId: string):
  | { abortController: AbortController; timer: NodeJS.Timeout }
  | undefined {
  return activeGenerations.get(sessionId);
}

/** Test-only helper for exercising generation timeout orchestration directly. */
export async function __runGenerationWithTimeoutForTests<T>(
  sessionId: string,
  operation: (abortSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const session = getSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }
  return runGenerationWithTimeout(session, operation);
}

// ── Custom Errors ───────────────────────────────────────────────────────────

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotFoundError";
  }
}

export class InvalidSessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSessionStateError";
  }
}

export class GenerationInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationInProgressError";
  }
}
