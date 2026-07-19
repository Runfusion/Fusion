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
  ThinkingLevel,
  MessageStore,
} from "@fusion/core";
import {
  DASHBOARD_USER_ID,
  DEFAULT_TASK_PRIORITY,
  TASK_PRIORITIES,
  THINKING_LEVELS,
  resolvePrompt,
  summarizeTitle,
  type PromptOverrideMap,
} from "@fusion/core";
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
  buildSessionSkillContextSync,
  createChatTaskDocumentTools,
  createChatTaskLogsReadTool,
  createFnAgent as engineCreateFnAgent,
  createWorkflowAuthoringTools,
  resolveMcpServersForStore,
} from "@fusion/engine";
import * as engineModule from "@fusion/engine";
import { createPlanningBoardTools } from "./planning-board-tools.js";

// The planning lane has no ambient task; fn_workflow_select therefore has no
// default target and an agent must pass an explicit task_id.
const PLANNING_NO_AMBIENT_TASK_ID = "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentResult = any;
type SkillPluginRunner = Parameters<typeof buildSessionSkillContextSync>[3];
type AgentMessage = {
  role: string;
  content?: string | Array<{ type: string; text?: string; thinking?: string }>;
};

const PLANNING_BUILTIN_WEB_TOOLS = ["WebSearch", "WebFetch"] as const;
type PlanningMcpServers = Awaited<ReturnType<typeof resolveMcpServersForStore>>["servers"];
type PlanningSessionOptions = {
  projectId?: string;
  ntfyConfig?: PlanningNtfyConfig;
  clarificationEnabled?: boolean;
  /** Runtime-only mailbox dependency; never serialize this store. */
  messageStore?: MessageStore;
  pluginRunner?: SkillPluginRunner;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createFnAgent: any = engineCreateFnAgent;

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel);
}

async function resolvePlanningMcpServers(store: TaskStore): Promise<PlanningMcpServers> {
  const resolved = await resolveMcpServersForStore(store);
  /*
  FNXC:McpConfig 2026-07-02-13:45:
  Planning lanes must forward shaped MCP server arrays, while dashboard route-test mocks may omit the resolver result entirely.
  Default only malformed test-seam output to an empty in-memory set so configured servers and secret-bearing materialized fields are never logged or persisted here.
  */
  if (!resolved || !Array.isArray(resolved.servers)) {
    return [];
  }
  return resolved.servers;
}

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
export const PLANNING_SYSTEM_PROMPT = `You are a planning assistant for the fn task board system. First analyze the codebase and active board with the available read tools, fn_task_list, and fn_task_show. Turn a raw idea into an incrementally maintained plan.

Ask exactly one next, high-impact question on every turn. Use every prior answer as context, avoid repeated questions, and never decide that the interview is complete or emit a terminal/complete response. The user alone validates the plan.

Respond only with JSON: {"type":"question","data":{"id":"unique-id","type":"single_select|multi_select","question":"...","description":"...","options":[{"id":"option-a","label":"...","description":"...","pros":["..."],"cons":["..."]},{"id":"option-b","label":"...","description":"...","pros":["..."],"cons":["...]},{"id":"other","label":"...","isOther":true}]}}.

Every question must provide at least two alternatives, each with non-empty pros and cons, plus exactly one Other/write-your-own option. Write every label, option, and Other label in the language of the user's original input. Incorporate free-text Other answers verbatim as steering context for the following question.`;



/** Placeholder title for draft sessions before the user starts planning. */
export const DRAFT_PLACEHOLDER_TITLE = "New planning session";

/**
 * Shape of the JSON blob persisted in `ai_sessions.inputPayload` for draft
 * planning sessions. Carries the in-progress plan text plus an optional
 * model override so reopening a draft restores the model selection the user
 * picked at create time, and so summarizeDraftTitle calls hit that same
 * model rather than silently falling back to project defaults.
 *
 * FNXC:Planning 2026-07-12-00:00:
 * Planning drafts/sessions persist a validated per-session reasoning effort in inputPayload so draft reopen and start-existing rebuilds preserve the selected thinking level without a SQLite schema change.
 *
 * `summarizedFor` records the exact `initialPlan` string the current
 * persisted title was summarized from. The start-existing path uses it to
 * skip re-summarizing when blur/close already produced a title for the
 * final text, avoiding a redundant model call.
 */
export interface DraftInputPayload {
  initialPlan?: string;
  clarificationEnabled?: boolean;
  lastMailboxNotifiedQuestionKey?: string;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  summarizedFor?: string;
  validated?: boolean;
}

/** Session TTL in milliseconds (7 days) */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cleanup interval in milliseconds (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Max planning sessions per IP per hour */
const MAX_SESSIONS_PER_IP_PER_HOUR = 1000;

/** Rate limiting window in milliseconds (1 hour) */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/*
FNXC:PlanningLiveness 2026-06-24-00:00:
Planning Mode must allow long-running reasoning when the agent is producing new thinking/text, because a fixed wall-clock cap incorrectly fails legitimate sessions. The watchdog is scoped to Planning Mode and treats this value as an inactivity window: non-empty, materially new output refreshes liveness; repeated identical output is counted separately and stopped as a loop so stuck sessions still fail deterministically without changing subtask, mission, milestone, or onboarding timeout semantics.
*/
export const GENERATION_TIMEOUT_MS = 120_000;

/** Repeated identical planning stream chunks before the generation is classified as looping. */
export const GENERATION_LOOP_REPEAT_LIMIT = 8;

const PLANNING_STUCK_ERROR_MESSAGE = "AI generation appears stuck with no new output. You can retry or start a new session.";
const PLANNING_LOOP_ERROR_MESSAGE = "AI generation appears stuck repeating the same output. You can retry or start a new session.";
const PLANNING_USER_STOP_ERROR_MESSAGE = "Generation stopped by user. You can retry or start a new session.";

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
  /** Per-session reasoning effort persisted with the draft/session and threaded into planning agents when set. */
  draftThinkingLevel?: ThinkingLevel;
  /** Plan text the current title was summarized from; lets startExistingSession skip a redundant re-summarize when blur/close already covered the final text. */
  draftSummarizedFor?: string;
  ntfyConfig?: PlanningNtfyConfig;
  /** Persisted per-session override for proactive AI clarification checkpoints. */
  clarificationEnabled?: boolean;
  /** Runtime-only mailbox dependency, attached by the current route. */
  messageStore?: MessageStore;
  autoMerge?: boolean;
  /** Last planning question notified via ntfy, keyed as `${sessionId}:${questionId}` for dedupe across reconnect/replay. */
  lastNotifiedQuestionKey?: string;
  /** Durable fast-path marker; the inbox lookup remains authoritative after a crash. */
  lastMailboxNotifiedQuestionKey?: string;
  history: PlanningHistoryEntry[];
  currentQuestion?: PlanningQuestion;
  /** Question currently being edited; history is preserved rather than truncated. */
  editingQuestionId?: string;
  summary?: PlanningSummary;
  /** User-controlled finalization state. */
  validated: boolean;
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
  /** Plugin runner captured while the server is alive so rebuilt planning agents keep plugin-contributed skills. */
  pluginRunner?: SkillPluginRunner;
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

type PlanningGenerationAbortReason = "stuck" | "loop" | "user-stop" | "displaced";

interface ActivePlanningGeneration {
  abortController: AbortController;
  timer: NodeJS.Timeout;
  abortReason?: PlanningGenerationAbortReason;
  abortTeardownFired: boolean;
  abortTeardown: () => void;
  markProgress: (output: string) => void;
}

/** Active planning generations keyed by session ID. */
const activeGenerations = new Map<string, ActivePlanningGeneration>();

// ── AI Session Persistence ────────────────────────────────────────────────

/** Optional store for persisting session state across reloads/browsers. */
let _aiSessionStore: AiSessionStore | undefined;
let _aiSessionDeletedListener: ((sessionId: string) => void) | undefined;
const sessionPersistenceQueues = new Map<string, Promise<void>>();

function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

/*
FNXC:PlanningNormalization 2026-06-25-00:00:
AI responses and persisted planning rows are untrusted runtime data. Normalize omitted or malformed summary arrays to [] at the session boundary so #1743-style undefined `.map` crashes cannot reach live streams, resume, task creation, or breakdown generation.
*/
export function normalizePlanningSummaryPayload(
  summaryInput: unknown,
  fallback?: { title?: string; description?: string },
): PlanningSummary {
  const summary = summaryInput && typeof summaryInput === "object" && !Array.isArray(summaryInput)
    ? summaryInput as Record<string, unknown>
    : {};

  const title = typeof summary.title === "string" && summary.title.trim().length > 0
    ? summary.title.trim()
    : fallback?.title?.trim() || "Untitled planning task";
  const description = typeof summary.description === "string" && summary.description.trim().length > 0
    ? summary.description.trim()
    : fallback?.description?.trim() || title;

  return {
    title,
    description,
    suggestedSize: summary.suggestedSize === "S" || summary.suggestedSize === "M" || summary.suggestedSize === "L"
      ? summary.suggestedSize
      : "M",
    priority: isTaskPriority(summary.priority) ? summary.priority : DEFAULT_TASK_PRIORITY,
    suggestedDependencies: normalizeStringArray(summary.suggestedDependencies),
    keyDeliverables: normalizeStringArray(summary.keyDeliverables),
  };
}

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
    activeGeneration.abortReason = "user-stop";
    activeGeneration.abortTeardown();
    activeGeneration.abortController.abort();
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

/** Persist the current session state to PostgreSQL (no-op if store not wired). */
function persistSession(session: Session, status: "generating" | "awaiting_input" | "complete" | "error" | "draft", error?: string): Promise<void> {
  const store = _aiSessionStore;
  if (!store) return Promise.resolve();
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
      ...(session.draftThinkingLevel ? { thinkingLevel: session.draftThinkingLevel } : {}),
      ...(session.draftSummarizedFor ? { summarizedFor: session.draftSummarizedFor } : {}),
      validated: session.validated,
      ...(typeof session.clarificationEnabled === "boolean"
        ? { clarificationEnabled: session.clarificationEnabled }
        : {}),
      ...(session.lastMailboxNotifiedQuestionKey ? { lastMailboxNotifiedQuestionKey: session.lastMailboxNotifiedQuestionKey } : {}),
    }),
    conversationHistory: JSON.stringify(session.history),
    currentQuestion: session.currentQuestion ? JSON.stringify(session.currentQuestion) : null,
    result: session.summary ? JSON.stringify(session.summary) : null,
    thinkingOutput: session.thinkingOutput,
    error: error ?? null,
    projectId: session.projectId ?? null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: new Date().toISOString(),
  };
  /*
  FNXC:PostgresPlanningPersistence 2026-07-14-19:56:
  PostgreSQL writes are asynchronous, so rapid generating→awaiting_input transitions must be serialized per session. The request that creates the first question awaits the final queued write; otherwise an earlier generating upsert can land last and return stale state to another tab.
  */
  const previous = sessionPersistenceQueues.get(session.id) ?? Promise.resolve();
  const queued = previous.then(
    () => store.upsert(row),
    () => store.upsert(row),
  );
  const bestEffort = queued.catch(() => undefined);
  sessionPersistenceQueues.set(session.id, bestEffort);
  void bestEffort.then(() => {
    if (sessionPersistenceQueues.get(session.id) === bestEffort) {
      sessionPersistenceQueues.delete(session.id);
    }
  });
  return bestEffort;
}

/** Persist only thinking output (debounced). */
function persistThinking(sessionId: string, thinkingOutput: string): void {
  if (!_aiSessionStore) return;
  _aiSessionStore.updateThinking(sessionId, thinkingOutput);
}

/** Remove session from persistence after every older write for the session. */
function unpersistSession(sessionId: string): Promise<void> {
  const store = _aiSessionStore;
  if (!store) return Promise.resolve();

  /*
  FNXC:PostgresPlanningPersistence 2026-07-14-21:20:
  Session deletion shares the per-session persistence queue with upserts. A delete that overtakes an upsert after its tombstone check can otherwise allow that older write to recreate a cancelled or cleaned-up planning session.
  */
  const previous = sessionPersistenceQueues.get(sessionId) ?? Promise.resolve();
  const queued = previous.then(
    () => store.delete(sessionId),
    () => store.delete(sessionId),
  );
  /*
  FNXC:PostgresPlanningPersistence 2026-07-14-21:46:
  Session deletion is an authoritative operation, so callers must observe a PostgreSQL delete failure instead of reporting successful cleanup while the persisted row remains. The queue retains a handled promise so later operations can proceed, but this deletion call returns the original rejection.
  */
  const bestEffort = queued.catch(() => undefined);
  sessionPersistenceQueues.set(sessionId, bestEffort);
  void bestEffort.then(() => {
    if (sessionPersistenceQueues.get(sessionId) === bestEffort) {
      sessionPersistenceQueues.delete(sessionId);
    }
  });
  return queued;
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

  const thinkingLevel = isThinkingLevel(payload.thinkingLevel) ? payload.thinkingLevel : undefined;

  const createdAt = new Date(row.createdAt);
  const updatedAt = new Date(row.updatedAt);

  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())) {
    throw new Error("Invalid session timestamps");
  }

  /*
  FNXC:PlanningRetry 2026-07-14-00:00:
  Only an awaiting_input row has a live question. Rows persisted while generating/error by
  pre-fix builds still carry the already-answered question; restoring it would let the SSE
  catch-up path re-emit it and re-trigger the answered-question retry loop after a restart.
  */
  const history = safeParseJson<PlanningHistoryEntry[]>(
    row.conversationHistory,
    [],
    { throwOnError: true, fieldName: "conversationHistory" },
  );
  const persistedSummary = row.result
    ? normalizePlanningSummaryPayload(
        safeParseJson<unknown | null>(row.result, null, {
          throwOnError: true,
          fieldName: "result",
        }),
        { title: row.title, description: row.title },
      )
    : undefined;
  const skippedMandatoryInterview = false;
  const currentQuestion = skippedMandatoryInterview
    ? buildMandatoryFirstPlanningQuestion()
    : row.status === "awaiting_input" && row.currentQuestion
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
    draftThinkingLevel: thinkingLevel,
    draftSummarizedFor: payload.summarizedFor,
    clarificationEnabled: typeof payload.clarificationEnabled === "boolean"
      ? payload.clarificationEnabled
      : undefined,
    lastMailboxNotifiedQuestionKey: typeof payload.lastMailboxNotifiedQuestionKey === "string"
      ? payload.lastMailboxNotifiedQuestionKey
      : undefined,
    history,
    currentQuestion,
    lastNotifiedQuestionKey: currentQuestion ? `${row.id}:${currentQuestion.id}` : undefined,
    summary: persistedSummary ?? buildRunningSummary(payload.initialPlan ?? row.title, history),
    validated: payload.validated === true,
    thinkingOutput: row.thinkingOutput,
    lastGeneratedThinking: row.thinkingOutput || "",
    error: row.error ?? undefined,
    createdAt,
    updatedAt,
    agent: undefined,
  };
}

export async function rehydrateFromStore(store: AiSessionStore): Promise<number> {
  let rows: AiSessionRow[] = [];

  try {
    rows = (await store.listRecoverable()).filter((row) => row.type === "planning");
  } catch (error) {
    diagnostics.errorFromException("Failed to list recoverable sessions", error, { operation: "list-recoverable" });
    return 0;
  }

  let rehydrated = 0;
  for (const row of rows) {
    try {
      const session = buildSessionFromRow(row);
      sessions.set(session.id, session);
      if (session.currentQuestion && session.history.length === 0 && row.result) {
        /* FNXC:PlanningMode 2026-07-18-11:36: Rehydration repairs legacy no-history summaries into the mandatory interview question so reconnects cannot revive a skipped interview. */
        persistSession(session, "awaiting_input");
      }
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
  pluginRunner?: SkillPluginRunner,
  options?: Pick<PlanningSessionOptions, "ntfyConfig" | "messageStore" | "clarificationEnabled">,
): Promise<{ sessionId: string; firstQuestion: PlanningQuestion; summary: PlanningSummary; validated: boolean }> {
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
    summary: buildRunningSummary(initialPlan, []),
    validated: false,
    thinkingOutput: "",
    lastGeneratedThinking: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    store,
    rootDir,
    pluginRunner,
    clarificationEnabled: options?.clarificationEnabled === true,
    ntfyConfig: options?.ntfyConfig,
    messageStore: options?.messageStore,
  };

  sessions.set(sessionId, session);
  persistSession(session, "generating");

  // Resolve the effective system prompt (override or default)
  const baseSystemPrompt = resolvePrompt("planning-system", promptOverrides) || PLANNING_SYSTEM_PROMPT;
  const systemPrompt = baseSystemPrompt;

  // Create AI agent and get the first question
  // Only await engineReady if createFnAgent hasn't been set externally (e.g., via __setCreateFnAgent)
  if (!createFnAgent) {
    await ensureEngineReady();
  }

  const skillContext = buildSessionSkillContextSync(null, "executor", rootDir, pluginRunner);

  /*
  FNXC:PlanningSkills 2026-06-17-19:33:
  Planning sessions are agent-acting lanes with planning and workflow tools, so they must request the same executor role fallback plus enabled plugin skills (for example ce-debug) as task execution sessions.
  */
  const agentResult = await createFnAgent({
    cwd: rootDir,
    systemPrompt,
    tools: "readonly",
    ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    builtinToolsAllowlist: [...PLANNING_BUILTIN_WEB_TOOLS],
    // FNXC:McpConfig 2026-06-25-22:31: Planning/chat session creation resolves trusted MCP servers through the dashboard-scoped store and forwards only the materialized in-memory set to the engine runtime guard.
    // FNXC:McpConfig 2026-06-29-00:00: Planning sessions are intentionally read-only but still need configured MCP documentation/context tools; opt in at the session boundary while preserving engine-side namespacing, filtering, wrappers, and disposal.
    mcpServers: await resolvePlanningMcpServers(store),
    allowMcpToolsInReadonly: true,
    customTools: [
      ...createPlanningBoardTools(store),
      ...createWorkflowAuthoringTools(store, PLANNING_NO_AMBIENT_TASK_ID, { stripApprovalFlags: true }),
      /*
      FNXC:PlanningTools 2026-06-18-07:11:
      FN-6640 gives planning agents parity with chat for `fn_task_document_write` and `fn_task_document_read` after FN-6635. The planning lane has no ambient task (`PLANNING_NO_AMBIENT_TASK_ID`), so these document tools must require an explicit `task_id`, mirroring no-ambient workflow authoring tools.

      FNXC:ArtifactRegistry 2026-06-21-00:00:
      Planning sessions do not own the dashboard MessageStore, so artifact tools stay excluded here until the planning lane can thread the same inbox dependency as chat. This preserves the FN-6778 requirement that registration notifications use an existing MessageStore rather than constructing a new one.
      */
      ...createChatTaskDocumentTools(store),
      createChatTaskLogsReadTool(store),
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
  const firstResponse = await getFirstQuestionFromAgent(session, initialPlan);

  const firstQuestion = firstResponse.data;
  session.currentQuestion = firstQuestion;
  session.updatedAt = new Date();
  await persistSession(session, "awaiting_input");
  void maybeNotifyPlanningAwaitingInput(session, firstQuestion, true);

  session.summary = buildRunningSummary(initialPlan, session.history);
  return { sessionId, firstQuestion, summary: session.summary, validated: false };
}

/**
 * Get the first question from the AI agent by sending the initial plan.
 * Waits for the agent response and parses it as a PlanningQuestion.
 * Throws if the agent returns a summary instead of a question.
 */
async function getFirstQuestionFromAgent(
  session: Session,
  message: string,
): Promise<{ type: "question"; data: PlanningQuestion }> {
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
    const errorMessage = buildRetryableParseErrorMessage(lastError);
    setSessionError(session, errorMessage);
    // Keep the session and persisted error state so retry can reuse the original project context.
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
    throw new Error(`Failed to get first question from AI: ${errorMessage}`);
  }

  if (parsed.type === "question") {
    return { type: "question", data: normalizePlanningQuestion(parsed.data, session.initialPlan) };
  }

  /*
  FNXC:PlanningMode 2026-07-18-11:36:
  FN-8331 makes the first planning turn an interview invariant: a completion cannot become a
  deepening checkpoint until the user has answered a real clarifying question. Re-prompt once
  for the required protocol shape, then use a safe local question if the model still refuses.
  */
  return requestMandatoryFirstPlanningQuestion(session);
}

function buildMandatoryFirstPlanningQuestion(userInput = ""): PlanningQuestion {
  const fallback = planningFallbackCopy(userInput);
  return normalizePlanningQuestion({
    id: "mandatory-planning-clarification",
    type: "single_select",
    question: fallback.question,
  }, userInput);
}

async function requestMandatoryFirstPlanningQuestion(
  session: Session,
  abortSignal?: AbortSignal,
): Promise<{ type: "question"; data: PlanningQuestion }> {
  try {
    await (session.agent!.session.prompt as (input: string, options?: { signal?: AbortSignal }) => Promise<void>)(
      'Before producing a plan, ask one clarifying question. Return ONLY valid JSON: {"type":"question","data":{...}}.',
      { signal: abortSignal },
    );
    const retryMessage = (session.agent!.session.state.messages as AgentMessage[])
      .filter((m) => m.role === "assistant")
      .pop();
    const retryText = typeof retryMessage?.content === "string"
      ? retryMessage.content
      : Array.isArray(retryMessage?.content)
        ? retryMessage.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("")
        : "";
    const retryResponse = parseAgentResponse(retryText);
    if (retryResponse.type === "question") {
      return { type: "question", data: normalizePlanningQuestion(retryResponse.data, session.initialPlan) };
    }
  } catch (error) {
    diagnostics.warn("Agent did not supply the mandatory first planning question", {
      sessionId: session.id,
      message: error instanceof Error ? error.message : String(error),
      operation: "mandatory-first-question",
    });
  }
  return { type: "question", data: buildMandatoryFirstPlanningQuestion(session.initialPlan) };
}

export async function createDraftSession(
  ip: string,
  initialPlan: string,
  _rootDir: string,
  modelProvider?: string,
  modelId?: string,
  thinkingLevelOrPromptOverrides?: ThinkingLevel | PromptOverrideMap,
  _promptOverridesOrOptions?: PromptOverrideMap | { projectId?: string },
  optionsMaybe?: { projectId?: string },
): Promise<{ sessionId: string; title: string }> {
  const thinkingLevel = isThinkingLevel(thinkingLevelOrPromptOverrides) ? thinkingLevelOrPromptOverrides : undefined;
  const options = (isThinkingLevel(thinkingLevelOrPromptOverrides) ? optionsMaybe : _promptOverridesOrOptions) as { projectId?: string } | undefined;
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
    draftThinkingLevel: thinkingLevel,
    // Draft creation has no resolved settings context; startExistingSession
    // applies the request override/global default before generation begins.
    clarificationEnabled: undefined,
    history: [],
    summary: buildRunningSummary(initialPlan, []),
    validated: false,
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

  const row = await _aiSessionStore.get(sessionId);
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
  const latest = await _aiSessionStore.get(sessionId);
  if (!latest || latest.status !== "draft") {
    return latest?.title ?? null;
  }

  _aiSessionStore.markDraftSummarized(sessionId, finalTitle, trimmed).catch(() => { /* best-effort */ });
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
  thinkingLevelOrPromptOverrides?: ThinkingLevel | PromptOverrideMap,
  promptOverridesOrPluginRunner?: PromptOverrideMap | SkillPluginRunner,
  pluginRunnerMaybe?: SkillPluginRunner,
  runtimeOptions?: Pick<PlanningSessionOptions, "ntfyConfig" | "messageStore" | "clarificationEnabled">,
): Promise<void> {
  const thinkingLevel = isThinkingLevel(thinkingLevelOrPromptOverrides) ? thinkingLevelOrPromptOverrides : undefined;
  const promptOverrides = isThinkingLevel(thinkingLevelOrPromptOverrides)
    ? (promptOverridesOrPluginRunner as PromptOverrideMap | undefined)
    : (thinkingLevelOrPromptOverrides as PromptOverrideMap | undefined);
  const pluginRunner = (isThinkingLevel(thinkingLevelOrPromptOverrides) ? pluginRunnerMaybe : promptOverridesOrPluginRunner) as SkillPluginRunner | undefined;
  let session = sessions.get(sessionId);

  // Draft sessions aren't included in rehydrateFromStore (which only loads
  // recoverable in-flight sessions), and a backend restart drops the in-memory
  // map entirely. Rebuild lazily from SQLite so persisted drafts can still be
  // started after a restart, and so updateDraft-only state survives.
  if (!session && _aiSessionStore) {
    const row = await _aiSessionStore.get(sessionId);
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
  let persistedThinkingLevel: ThinkingLevel | undefined;
  let persistedSummarizedFor: string | undefined;
  let cameFromDraft = false;
  if (_aiSessionStore) {
    const row = await _aiSessionStore.get(sessionId);
    if (row) {
      cameFromDraft = row.status === "draft";
      const payload = safeParseJson<DraftInputPayload>(row.inputPayload, {});
      if (payload.initialPlan) {
        session.initialPlan = payload.initialPlan;
      }
      persistedProvider = payload.modelProvider;
      persistedModelId = payload.modelId;
      persistedThinkingLevel = isThinkingLevel(payload.thinkingLevel) ? payload.thinkingLevel : undefined;
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

  session.draftThinkingLevel = thinkingLevel ?? persistedThinkingLevel;
  if (runtimeOptions) {
    session.clarificationEnabled = runtimeOptions.clarificationEnabled === true;
    session.ntfyConfig = runtimeOptions.ntfyConfig;
    session.messageStore = runtimeOptions.messageStore;
  }
  persistSession(session, "generating");
  planningStreamManager.registerInitialTurn(sessionId, () => {
    session.pluginRunner = pluginRunner;
    initializeAgent(session, rootDir, store, modelProvider, modelId, session.draftThinkingLevel, promptOverrides, pluginRunner).catch((err) => {
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
  thinkingLevelOrPromptOverrides?: ThinkingLevel | PromptOverrideMap,
  promptOverridesOrOptions?: PromptOverrideMap | PlanningSessionOptions,
  optionsMaybe?: PlanningSessionOptions,
): Promise<string> {
  const thinkingLevel = isThinkingLevel(thinkingLevelOrPromptOverrides) ? thinkingLevelOrPromptOverrides : undefined;
  const promptOverrides = isThinkingLevel(thinkingLevelOrPromptOverrides)
    ? (promptOverridesOrOptions as PromptOverrideMap | undefined)
    : (thinkingLevelOrPromptOverrides as PromptOverrideMap | undefined);
  const options = (isThinkingLevel(thinkingLevelOrPromptOverrides) ? optionsMaybe : promptOverridesOrOptions) as PlanningSessionOptions | undefined;
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
    clarificationEnabled: options?.clarificationEnabled === true,
    messageStore: options?.messageStore,
    history: [],
    summary: buildRunningSummary(initialPlan, []),
    validated: false,
    thinkingOutput: "",
    lastGeneratedThinking: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    draftThinkingLevel: thinkingLevel,
    pluginRunner: options?.pluginRunner,
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
      thinkingLevel,
      promptOverrides,
      options?.pluginRunner,
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
  thinkingLevel?: ThinkingLevel,
  promptOverrides?: PromptOverrideMap,
  pluginRunner?: SkillPluginRunner,
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
        thinkingLevel,
        promptOverrides,
        pluginRunner,
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
  thinkingLevel?: ThinkingLevel,
  promptOverrides?: PromptOverrideMap,
  pluginRunner?: SkillPluginRunner,
): Promise<AgentResult> {
  // Ensure engine is loaded before using createFnAgent
  await ensureEngineReady();

  // Resolve the effective system prompt (override or default)
  const baseSystemPrompt = resolvePrompt("planning-system", promptOverrides) || PLANNING_SYSTEM_PROMPT;
  const systemPrompt = baseSystemPrompt;

  const skillContext = buildSessionSkillContextSync(null, "executor", rootDir, pluginRunner);

  /*
  FNXC:PlanningSkills 2026-06-17-19:33:
  Streaming planning sessions share the executor skill contract because custom planning/workflow tools can benefit from agent-declared skills and enabled plugin skills exactly like task execution.
  */
  return createFnAgent({
    cwd: rootDir,
    systemPrompt,
    tools: "readonly",
    ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    builtinToolsAllowlist: [...PLANNING_BUILTIN_WEB_TOOLS],
    // FNXC:McpConfig 2026-06-25-22:31: Streaming planning uses the same dashboard-scoped MCP resolution seam as non-streaming planning so no planning lane silently drops enabled servers.
    // FNXC:McpConfig 2026-06-29-00:00: Streaming planning uses the explicit read-only MCP opt-in; non-planning read-only lanes remain denied unless they set the same reviewed policy flag.
    mcpServers: await resolvePlanningMcpServers(store),
    allowMcpToolsInReadonly: true,
    customTools: [
      ...createPlanningBoardTools(store),
      ...createWorkflowAuthoringTools(store, PLANNING_NO_AMBIENT_TASK_ID, { stripApprovalFlags: true }),
      /* FNXC:ArtifactRegistry 2026-06-21-00:00: Streaming planning excludes artifact tools for the same reason as non-streaming planning: this module has no MessageStore dependency to provide best-effort dashboard inbox notifications. */
      ...createChatTaskDocumentTools(store),
      createChatTaskLogsReadTool(store),
    ],
    ...(modelProvider && modelId
      ? {
          defaultProvider: modelProvider,
          defaultModelId: modelId,
        }
      : {}),
    ...(thinkingLevel ? { defaultThinkingLevel: thinkingLevel } : {}),
    onThinking: (delta: string) => {
      markPlanningGenerationProgress(session.id, delta);
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
      markPlanningGenerationProgress(session.id, delta);
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

  session.agent = await createPlanningAgent(session, effectiveRootDir, effectiveStore, undefined, undefined, session.draftThinkingLevel, promptOverrides, session.pluginRunner);

  if (historyForReplay.length === 0) {
    return;
  }

  const contextMessage = buildHistoryReplayPrompt(historyForReplay);
  await runGenerationWithTimeout(session, async (abortSignal) => {
    /*
    FNXC:AiSessionCancellation 2026-07-13-00:00:
    Planning history replay is an agent prompt surface too. Forward the generation AbortSignal and rely on runGenerationWithTimeout to tear down the in-flight session because Promise.race alone cannot cancel prompt() work.
    */
    if (abortSignal.aborted) {
      throw createAbortError();
    }
    await (session.agent!.session.prompt as (input: string, options?: { signal?: AbortSignal }) => Promise<void>)(contextMessage, {
      signal: abortSignal,
    });
    if (abortSignal.aborted) {
      throw createAbortError();
    }
  });
}

async function maybeNotifyPlanningAwaitingInput(
  session: Session,
  question: PlanningQuestion,
  proactiveClarification = false,
): Promise<void> {
  const questionKey = `${session.id}:${question.id}`;

  /*
  FNXC:AgentClarification 2026-07-16-12:00:
  Proactive planner questions use an inbox message independently of ntfy. The
  inbox lookup is authoritative because a process can die after sendMessage but
  before the persisted marker write; ntfy remains best-effort and separately deduped.
  */
  if (proactiveClarification && session.clarificationEnabled && session.messageStore
    && session.lastMailboxNotifiedQuestionKey !== questionKey) {
    try {
      const inbox = await session.messageStore.getInbox(DASHBOARD_USER_ID, "user", { type: "system" });
      const delivered = inbox.some((message) => message.metadata?.kind === "planning-clarification"
        && message.metadata?.sessionId === session.id && message.metadata?.questionId === question.id);
      if (!delivered) {
        await session.messageStore.sendMessage({
          fromType: "system",
          toType: "user",
          toId: DASHBOARD_USER_ID,
          type: "system",
          content: `Planning needs your answer in the planner chat: ${question.question}`,
          metadata: { kind: "planning-clarification", sessionId: session.id, questionId: question.id },
        });
      }
      session.lastMailboxNotifiedQuestionKey = questionKey;
      await persistSession(session, "awaiting_input");
    } catch (error) {
      diagnostics.warn("Failed to deliver planning clarification mailbox message", {
        sessionId: session.id, questionId: question.id,
        error: error instanceof Error ? error.message : String(error), operation: "planning-clarification-mailbox",
      });
    }
  }

  // Summary deepening checkpoints retain their existing ntfy behavior regardless
  // of the clarification preference; only proactive questions are setting-gated.
  if (proactiveClarification && !session.clarificationEnabled) return;
  const config = session.ntfyConfig;
  if (!config?.enabled || !config.topic) return;

  await ensureNtfyHelpersReady();
  const eventEnabled = planningNtfyHelpers?.isNtfyEventEnabled
    ? planningNtfyHelpers.isNtfyEventEnabled(config.events, "planning-awaiting-input")
    : (config.events ? config.events.includes("planning-awaiting-input") : true);
  if (!eventEnabled || session.lastNotifiedQuestionKey === questionKey) return;
  session.lastNotifiedQuestionKey = questionKey;
  if (!planningNtfyHelpers) return;
  try {
    const clickUrl = planningNtfyHelpers.buildNtfyClickUrl({ dashboardHost: config.dashboardHost, projectId: session.projectId });
    await planningNtfyHelpers.sendNtfyNotification({ ntfyBaseUrl: config.ntfyBaseUrl, topic: config.topic,
      title: "Planning needs your input", message: `Planning mode is waiting for input: ${question.question}`, priority: "high", clickUrl });
  } catch (error) {
    diagnostics.warn("Failed to deliver planning awaiting-input ntfy notification", {
      sessionId: session.id, questionId: question.id, error: error instanceof Error ? error.message : String(error), operation: "planning-notify-awaiting-input",
    });
  }
}

/** Max number of retry attempts when AI returns unparseable output */
const MAX_PARSE_RETRIES = 1;

/*
FNXC:PlanningJsonRecovery 2026-06-24-20:58:
Planning Mode malformed AI output must either recover through the bounded reformat prompt to a valid planning response or persist a retryable session error. Parser candidate selection therefore prefers valid planning-shaped JSON over unrelated larger JSON blobs embedded in model prose.
*/

function buildRetryableParseErrorMessage(error: Error | undefined): string {
  const baseMessage = (error?.message || "Failed to parse AI response")
    .replace(/\s*Please try again\.?\s*$/i, "")
    .trim();
  return `${baseMessage}. Retry this planning session or start a new one.`;
}

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

function normalizeGenerationProgress(output: string): string {
  return output.replace(/\s+/g, " ").trim();
}

function markPlanningGenerationProgress(sessionId: string, output: string): void {
  activeGenerations.get(sessionId)?.markProgress(output);
}

async function runGenerationWithTimeout<T>(session: Session, operation: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
  const existing = activeGenerations.get(session.id);
  if (existing) {
    clearTimeout(existing.timer);
    existing.abortReason = "displaced";
    existing.abortTeardown();
    existing.abortController.abort();
  }

  const abortController = new AbortController();
  let lastProgressSignature = "";
  let repeatedProgressCount = 0;

  const abortGeneration = (reason: PlanningGenerationAbortReason, message?: string): void => {
    if (abortController.signal.aborted) {
      return;
    }
    generationRecord.abortReason = reason;
    clearTimeout(generationRecord.timer);
    if (message) {
      diagnostics.warn("Planning generation watchdog aborting session", {
        sessionId: session.id,
        reason,
        operation: "planning-generation-watchdog",
      });
      setSessionError(session, message);
    }
    generationRecord.abortTeardown();
    abortController.abort();
  };

  const scheduleInactivityTimer = (): NodeJS.Timeout => setTimeout(() => {
    abortGeneration("stuck", PLANNING_STUCK_ERROR_MESSAGE);
  }, GENERATION_TIMEOUT_MS);

  const generationRecord: ActivePlanningGeneration = {
    abortController,
    timer: scheduleInactivityTimer(),
    abortTeardownFired: false,
    abortTeardown: () => {
      if (generationRecord.abortTeardownFired) {
        return;
      }
      generationRecord.abortTeardownFired = true;
      /*
      FNXC:AiSessionCancellation 2026-07-13-00:00:
      Planning has a local generation runner instead of GenerationGuard. Abort teardown must run once for timeout, user-stop, displacement, stuck, and loop aborts so an abandoned prompt cannot continue after the Promise.race waiter rejects.
      */
      disposeSessionAgentForRetry(session);
    },
    markProgress: (output: string) => {
      const signature = normalizeGenerationProgress(output);
      if (!signature) {
        return;
      }

      if (signature === lastProgressSignature) {
        repeatedProgressCount += 1;
        if (repeatedProgressCount >= GENERATION_LOOP_REPEAT_LIMIT) {
          abortGeneration("loop", PLANNING_LOOP_ERROR_MESSAGE);
        }
        return;
      }

      lastProgressSignature = signature;
      repeatedProgressCount = 0;
      clearTimeout(generationRecord.timer);
      generationRecord.timer = scheduleInactivityTimer();
    },
  };

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
      const reason = generationRecord.abortReason;
      if (reason === "user-stop" && !session.error) {
        setSessionError(session, PLANNING_USER_STOP_ERROR_MESSAGE);
      }
    }
    throw error;
  } finally {
    clearTimeout(generationRecord.timer);
    if (activeGenerations.get(session.id) === generationRecord) {
      activeGenerations.delete(session.id);
    }
  }
}

/**
 * FNXC:PlanningMode 2026-07-18-16:00:
 * Planning is an infinite, user-gated interview. A running plan is derived after every
 * turn and only validateSession may mark it final; model completion payloads are coerced
 * into another question rather than terminating the session.
 */
function buildRunningSummary(initialPlan: string, history: PlanningHistoryEntry[]): PlanningSummary {
  const answers = history.map((entry) => `${entry.question.question}: ${JSON.stringify(entry.response)}`);
  return normalizePlanningSummaryPayload({
    title: initialPlan.slice(0, 80) || "Untitled planning task",
    description: [initialPlan, ...answers].filter(Boolean).join("\n\n"),
    suggestedSize: "M",
    suggestedDependencies: [],
    keyDeliverables: history.map((entry) => entry.question.question),
  }, { title: initialPlan, description: initialPlan });
}

function planningFallbackCopy(input: string): { question: string; option: (n: number) => string; pro: string; con: string; other: string } {
  if (/[一-龯]/.test(input)) {
    const traditional = /[繁體臺灣與為這個]/.test(input);
    return traditional
      ? { question: "下一步最需要釐清的細節或限制是什麼？", option: (n) => `替代方案 ${n}`, pro: "提供明確的前進方向", con: "可能限制後續選擇", other: "其他（自行填寫）" }
      : { question: "接下来最需要细化的细节或限制是什么？", option: (n) => `替代方案 ${n}`, pro: "提供清晰的推进方向", con: "可能限制后续选择", other: "其他（自行填写）" };
  }
  if (/[가-힣]/.test(input)) return { question: "다음으로 구체화할 가장 중요한 세부 사항이나 제약은 무엇인가요?", option: (n) => `대안 ${n}`, pro: "명확한 진행 방향을 제공합니다", con: "후속 선택을 제한할 수 있습니다", other: "기타(직접 입력)" };
  if (/\b(le|la|les|une|fonctionnalité)\b/i.test(input)) return { question: "Quel est le prochain détail ou contrainte le plus important à préciser ?", option: (n) => `Alternative ${n}`, pro: "Donne une direction claire", con: "Peut limiter les choix ultérieurs", other: "Autre (écrivez votre réponse)" };
  if (/\b(el|la|los|una|función|característica|español(?:es)?)\b/i.test(input)) return { question: "¿Cuál es el siguiente detalle o restricción más importante que debemos precisar?", option: (n) => `Alternativa ${n}`, pro: "Ofrece una dirección clara", con: "Puede limitar decisiones posteriores", other: "Otro (escribe tu respuesta)" };
  return { question: "What is the next most important detail or constraint to refine?", option: (n) => `Option ${n}`, pro: "Provides a clear path forward", con: "May constrain later choices", other: "Other (write your own)" };
}

/** Normalizes untrusted model output so select questions always meet the public option contract. */
export function normalizePlanningQuestion(input: unknown, userInput = ""): PlanningQuestion {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const fallback = planningFallbackCopy(userInput);
  // Every Planning question needs alternatives and an Other steer, so a model's legacy
  // text question is upgraded to a select question instead of losing that escape hatch.
  const type = source.type === "multi_select" || source.type === "single_select" ? source.type : "single_select";
  const question = typeof source.question === "string" && source.question.trim() ? source.question.trim() : fallback.question;
  const normalized: PlanningQuestion = { id: typeof source.id === "string" && source.id.trim() ? source.id : randomUUID(), type, question,
    ...(typeof source.description === "string" && source.description.trim() ? { description: source.description.trim() } : {}) };
  const raw = Array.isArray(source.options) ? source.options : [];
  const alternatives = raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !(item as Record<string, unknown>).isOther)
    .slice(0, 2).map((item, index) => ({
      id: typeof item.id === "string" && item.id.trim() ? item.id : `option-${index + 1}`,
      label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : fallback.option(index + 1),
      ...(typeof item.description === "string" && item.description.trim() ? { description: item.description.trim() } : {}),
      pros: Array.isArray(item.pros) && item.pros.some((v) => typeof v === "string" && v.trim()) ? item.pros.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : [fallback.pro],
      cons: Array.isArray(item.cons) && item.cons.some((v) => typeof v === "string" && v.trim()) ? item.cons.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : [fallback.con],
    }));
  while (alternatives.length < 2) {
    const n = alternatives.length + 1;
    alternatives.push({ id: `option-${n}`, label: fallback.option(n), pros: [fallback.pro], cons: [fallback.con] });
  }
  normalized.options = [...alternatives, { id: "other", label: fallback.other, isOther: true }];
  return normalized;
}

function coerceQuestionResponse(response: PlanningResponse, session: Session): PlanningQuestion {
  if (response.type === "question") return normalizePlanningQuestion(response.data, session.initialPlan);
  return normalizePlanningQuestion({ id: randomUUID(), type: "single_select", question: planningFallbackCopy(session.initialPlan).question }, session.initialPlan);
}

export async function validateSession(sessionId: string): Promise<PlanningSummary> {
  const session = await getSession(sessionId);
  if (!session) throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);

  // FNXC:PlanningMode 2026-07-18-16:00: Validation is the terminal user action.
  // Cancel a concurrent turn and clear its question so it cannot race the completed row
  // back to awaiting_input after the user has finalized the running plan.
  const activeGeneration = activeGenerations.get(session.id);
  if (activeGeneration) {
    activeGeneration.abortReason = "user-stop";
    clearTimeout(activeGeneration.timer);
    activeGeneration.abortTeardown();
    activeGeneration.abortController.abort();
    activeGenerations.delete(session.id);
  }

  session.summary = buildRunningSummary(session.initialPlan, session.history);
  session.currentQuestion = undefined;
  session.editingQuestionId = undefined;
  session.validated = true;
  session.error = undefined;
  session.updatedAt = new Date();
  await persistSession(session, "complete");
  planningStreamManager.broadcast(session.id, { type: "summary", data: session.summary });
  planningStreamManager.broadcast(session.id, { type: "complete" });
  return session.summary;
}

async function continueAgentConversation(session: Session, message: string): Promise<void> {
  if (!session.agent) {
    throw new InvalidSessionStateError("AI agent not initialized");
  }

  try {
    await runGenerationWithTimeout(session, async (abortSignal) => {
      // Clear thinking output for this turn
      session.thinkingOutput = "";

      /*
      FNXC:AiSessionCancellation 2026-07-13-00:00:
      Planning turns and parse-retry prompts must pass the active AbortSignal to prompt() and short-circuit after abort. The local generation runner also tears down the agent session because provider SDKs may ignore the signal.
      */
      if (abortSignal.aborted) {
        throw createAbortError();
      }
      await (session.agent.session.prompt as (input: string, options?: { signal?: AbortSignal }) => Promise<void>)(message, {
        signal: abortSignal,
      });
      if (abortSignal.aborted) {
        throw createAbortError();
      }

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

    markPlanningGenerationProgress(session.id, responseText);

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
            if (abortSignal.aborted) {
              throw createAbortError();
            }
            await (session.agent.session.prompt as (input: string, options?: { signal?: AbortSignal }) => Promise<void>)(
              "Your previous response could not be parsed as JSON. " +
                'Please respond with ONLY a valid JSON object: either {"type":"question","data":{...}} ' +
                'or {"type":"complete","data":{...}}. No markdown, no explanation, just the JSON.',
              { signal: abortSignal },
            );
            if (abortSignal.aborted) {
              throw createAbortError();
            }
            
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
            markPlanningGenerationProgress(session.id, responseText);
          } catch (retryErr) {
            if (retryErr instanceof Error && retryErr.name === "AbortError") {
              throw retryErr;
            }
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
      // All attempts exhausted — emit actionable, retryable error without duplicated "Please try again" suffixes.
      const errorMsg = buildRetryableParseErrorMessage(lastError);
      diagnostics.error(
        "All parse attempts exhausted for session",
        { sessionId: session.id, message: errorMsg, operation: "parse-exhausted" }
      );
      setSessionError(session, errorMsg);
      return;
    }

      if (parsed.type === "question") {
        session.currentQuestion = coerceQuestionResponse(parsed, session);
        session.summary = buildRunningSummary(session.initialPlan, session.history);
        session.error = undefined;
        session.lastGeneratedThinking = session.thinkingOutput;
        session.updatedAt = new Date();
        // Persist after deriving the plan: reloads must see the running summary on every turn.
        persistSession(session, "awaiting_input");
        void maybeNotifyPlanningAwaitingInput(session, session.currentQuestion, true);
        planningStreamManager.broadcast(session.id, { type: "summary", data: session.summary });
        planningStreamManager.broadcast(session.id, { type: "question", data: session.currentQuestion });
      } else {
        // A generic engine completion is never terminal in Planning Mode.
        session.currentQuestion = coerceQuestionResponse(parsed, session);
        session.summary = buildRunningSummary(session.initialPlan, session.history);
        session.error = undefined;
        session.lastGeneratedThinking = session.thinkingOutput;
        session.updatedAt = new Date();
        persistSession(session, "awaiting_input");
        planningStreamManager.broadcast(session.id, { type: "summary", data: session.summary });
        planningStreamManager.broadcast(session.id, { type: "question", data: session.currentQuestion });
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
function isPlanningResponseShape(parsed: unknown): parsed is PlanningResponse {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    !("data" in parsed)
  ) {
    return false;
  }

  const typed = parsed as { type: string; data: unknown };
  return (
    (typed.type === "question" || typed.type === "complete") &&
    typed.data !== null &&
    typed.data !== undefined
  );
}

function parseJsonCandidateForShape(candidate: string): unknown | undefined {
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(repairJson(candidate).repaired);
    } catch {
      return undefined;
    }
  }
}

function extractJsonCandidate(text: string): string | null {
  if (!text || !text.trim()) return null;

  // 1. Try markdown code blocks first (most reliable when they contain a planning response).
  const codeBlockMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
  const codeBlockCandidates = codeBlockMatches
    .map((match) => match[1]?.trim())
    .filter((candidate): candidate is string => Boolean(candidate?.startsWith("{")));
  const planningCodeBlock = codeBlockCandidates.find((candidate) =>
    isPlanningResponseShape(parseJsonCandidateForShape(candidate)),
  );
  if (planningCodeBlock) return planningCodeBlock;
  if (codeBlockCandidates.length > 0) return codeBlockCandidates[0];

  // 2. Find all top-level brace-delimited objects using balanced brace counting.
  const candidates: Array<{ start: number; end: number; text: string; parsed?: unknown }> = [];
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
          candidates.push({ start: i, end: j, text: candidate, parsed: parseJsonCandidateForShape(candidate) });
          break;
        }
      }
    }
  }

  const planningCandidate = candidates.find((candidate) => isPlanningResponseShape(candidate.parsed));
  if (planningCandidate) return planningCandidate.text;

  /*
  FNXC:PlanningJsonRecovery 2026-07-28-12:00:
  FN-8260 must prefer a truncated top-level completion over a complete nested
  deliverable object, so a cutoff cannot silently select that nested object.
  */
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && isPlanningResponseShape(parseJsonCandidateForShape(trimmed))) {
    return trimmed;
  }

  // Pick the largest valid JSON candidate only after planning-shaped candidates are ruled out.
  const validCandidates = candidates.filter((candidate) => candidate.parsed !== undefined);
  if (validCandidates.length > 0) {
    validCandidates.sort((a, b) => b.text.length - a.text.length || a.start - b.start);
    return validCandidates[0].text;
  }

  // 3. Last resort: try the full trimmed text so repairJson can close truncated objects.
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
function repairJson(text: string): { repaired: string; wasTruncationRepaired: boolean } {
  let repaired = text;
  let wasTruncationRepaired = false;

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
    wasTruncationRepaired = true;
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
  const missingBrackets = Math.max(0, openBrackets);
  const missingBraces = Math.max(0, openBraces);
  if (missingBrackets > 0 || missingBraces > 0) {
    wasTruncationRepaired = true;
  }
  repaired += "]".repeat(missingBrackets);
  repaired += "}".repeat(missingBraces);

  return { repaired, wasTruncationRepaired };
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
class TruncatedPlanningCompletionError extends Error {
  constructor() {
    super("AI returned a truncated completion response");
    this.name = "TruncatedPlanningCompletionError";
  }
}

export function parseAgentResponse(text: string): PlanningResponse {
  const candidate = extractJsonCandidate(text);

  if (!candidate) {
    diagnostics.error("No JSON candidate found in agent response", { inputSnippet: text.slice(0, 500), operation: "parse-json" });
    throw new Error("AI returned no valid JSON. Please try again.");
  }

  let parsed: unknown;
  let wasTruncationRepaired = false;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Attempt repair for truncated/malformed JSON
    try {
      const repair = repairJson(candidate);
      wasTruncationRepaired = repair.wasTruncationRepaired;
      parsed = JSON.parse(repair.repaired);
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
  if (isPlanningResponseShape(parsed)) {
    /*
    FNXC:PlanningJsonRecovery 2026-07-28-12:00:
    FN-8260 / GitHub #2240 requires Planning Mode to treat a completion whose
    structure was closed by recovery as incomplete generation. Retrying here
    prevents a token-cutoff plan from reaching the checkpoint as an empty or
    chopped summary, while clean payloads and benign question repairs remain
    accepted.
    */
    if (parsed.type === "complete" && wasTruncationRepaired) {
      throw new TruncatedPlanningCompletionError();
    }
    return parsed;
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

/*
FNXC:PlanningRetry 2026-07-14-00:00:
currentQuestion is cleared once an answer is accepted, so a duplicate re-submit during the
in-flight generation is detected against the last history entry (the turn being generated)
instead of the now-cleared currentQuestion.
*/
function captureOtherCustomText(question: PlanningQuestion, responses: Record<string, unknown>): PlanningQuestion {
  const customText = typeof responses._other === "string" ? responses._other.trim() : "";
  if (!customText || !question.options?.some((option) => option.isOther)) return question;
  return {
    ...question,
    options: question.options.map((option) => option.isOther ? { ...option, customText } : option),
  };
}

function didSubmitSameAnswer(
  session: Session,
  responses: Record<string, unknown>,
): boolean {
  const lastEntry = session.history[session.history.length - 1];
  if (!lastEntry) {
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
  const session = await getSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  if (session.validated) {
    throw new InvalidSessionStateError("Planning session has already been validated");
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

  /*
  FNXC:PlanningRetry 2026-07-14-00:00:
  Reported bug: planning got stuck cycling retry/regeneration after the user had already answered.
  Root cause: session.currentQuestion kept the just-answered question all through the next
  generation, and the SSE stream route's catch-up path re-emits currentQuestion to every fresh
  connection. Each FN-7946 auto-retry opens a fresh SSE connection, so the client was handed the
  already-answered question again, which reset the bounded auto-retry budget and re-showed a
  stale question — an unbounded retry/regenerate loop. Invariant: currentQuestion is only set
  while the session is genuinely awaiting user input; it is cleared the moment an answer is
  accepted (below), on retry (retrySession), and never restored from non-awaiting_input rows
  (buildSessionFromRow). answeredQuestion preserves the legacy 200 response body for the
  generation-error case so the modal's submit path keeps its existing SSE-driven recovery.
  */
  let answeredQuestion: PlanningQuestion | undefined;

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
    const currentQuestion = captureOtherCustomText(session.currentQuestion, responses);
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
    const editIndex = session.editingQuestionId
      ? session.history.findIndex((entry) => entry.question.id === session.editingQuestionId)
      : -1;
    const isEditingPriorAnswer = editIndex >= 0;
    if (isEditingPriorAnswer) {
      session.history[editIndex] = historyEntry;
      session.editingQuestionId = undefined;
      // Existing agent context contains the old answer; rebuild it from the preserved history.
      disposeSessionAgentForRetry(session);
    } else {
      session.history.push(historyEntry);
    }
    answeredQuestion = currentQuestion;

    // Answered questions always lead to another question; no answer can validate or complete.
    session.currentQuestion = undefined;
    persistSession(session, "generating");
    if (!session.agent) {
      // An edited older answer must be replayed in its original position with every
      // later answer retained; only a newly appended answer is sent after replay.
      await ensureSessionAgent(
        session,
        rootDir,
        isEditingPriorAnswer ? session.history : session.history.slice(0, -1),
        promptOverrides,
        store,
      );
    }
    const message = isEditingPriorAnswer
      ? "An earlier answer was edited. Use the complete preserved interview context above, re-derive the running plan, and ask exactly one new high-impact next question."
      : formatResponseForAgent(currentQuestion, responses);
    await continueAgentConversation(session, message);
  }

  // Return the current state (will be updated via SSE)
  if (session.currentQuestion) {
    return { type: "question", data: session.currentQuestion };
  }

  /*
  FNXC:PlanningRetry 2026-07-14-00:00:
  Generation failed after the answer was accepted (session.error was set and broadcast via SSE).
  Historically this path returned the answered question with a 200 because currentQuestion was
  never cleared; the modal ignores the body and lets the SSE error drive auto-retry. Preserve
  that contract explicitly instead of throwing a 400 that would bounce the client back to the
  already-answered question view.
  */
  if (session.error && answeredQuestion) {
    return { type: "question", data: answeredQuestion };
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
  const session = await getSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  if (session.validated) {
    throw new InvalidSessionStateError("Planning session has already been validated");
  }

  if (store && !session.store) session.store = store;
  if (rootDir && !session.rootDir) session.rootDir = rootDir;

  const persisted = _aiSessionStore ? await _aiSessionStore.get(sessionId) : null;
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
  /*
  FNXC:PlanningRetry 2026-07-14-00:00:
  A retry regenerates the last turn, so no question is awaiting input. Clearing here also
  scrubs stale answered questions persisted by pre-fix builds; without this, the fresh SSE
  connection the retry path opens would be handed the answered question by the stream route's
  catch-up emit, resetting the FN-7946 auto-retry budget and looping forever.
  */
  session.currentQuestion = undefined;
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
  questionId?: string,
  rootDir?: string,
  promptOverrides?: PromptOverrideMap,
  store?: TaskStore,
): Promise<PlanningRewindResult> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  if (session.validated) {
    throw new InvalidSessionStateError("Planning session has already been validated");
  }

  if (store && !session.store) session.store = store;
  if (rootDir && !session.rootDir) session.rootDir = rootDir;

  if (session.history.length === 0) {
    throw new InvalidSessionStateError("Planning session has no previous question to rewind to");
  }

  const rewindIndex = questionId
    ? session.history.findIndex((entry) => entry.question.id === questionId)
    : session.history.length - 1;
  if (rewindIndex < 0) {
    throw new InvalidSessionStateError("Planning question to edit was not found");
  }
  const rewindEntry = session.history[rewindIndex]!;
  if (!questionId) session.history.pop();

  disposeSessionAgentForRetry(session);

  session.currentQuestion = rewindEntry.question;
  session.editingQuestionId = questionId ? questionId : undefined;
  // Keep the plan available while the user edits; it is re-derived after submit.
  session.summary = buildRunningSummary(session.initialPlan, session.history);
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

  activeGeneration.abortReason = "user-stop";
  clearTimeout(activeGeneration.timer);
  activeGeneration.abortTeardown();
  activeGeneration.abortController.abort();
  activeGenerations.delete(sessionId);

  setSessionError(session, PLANNING_USER_STOP_ERROR_MESSAGE);
  return true;
}

/**
 * Format user response as a message for the AI agent.
 */
export function formatResponseForAgent(
  question: PlanningQuestion,
  responses: Record<string, unknown>
): string {
  const responseValue = responses[question.id];
  const comment = typeof responses._comment === "string" ? responses._comment.trim() : "";
  const other = typeof responses._other === "string" ? responses._other.trim() : "";

  let formatted: string;

  switch (question.type) {
    case "text":
      formatted = `Question: ${question.question}\n\nAnswer: ${responseValue}`;
      break;

    case "single_select":
      /*
      FNXC:PlanningInterview 2026-06-26-00:00:
      GitHub #1794 requires Other-only single-select answers to reach the planning agent as the user's own answer instead of forcing a provided option id or rendering an undefined fallback.
      */
      if (other.length > 0) {
        formatted = `Question: ${question.question}\n\nSelected: ${other} (user's own answer)`;
        break;
      }
      if (typeof responseValue === "string") {
        const option = question.options?.find((o) => o.id === responseValue);
        formatted = `Question: ${question.question}\n\nSelected: ${option?.label || responseValue}`;
        break;
      }
      formatted = `Question: ${question.question}\n\nAnswer: ${responseValue}`;
      break;

    case "multi_select":
      if (Array.isArray(responseValue) || other.length > 0) {
        const selected = Array.isArray(responseValue) ? responseValue.map((id) => {
          const option = question.options?.find((o) => o.id === id);
          return option?.label || id;
        }) : [];
        /*
        FNXC:PlanningInterview 2026-06-26-00:00:
        Multi-select Other answers are additive agent context; append the free-text answer to the selected list and keep Other-only payloads from collapsing to a blank/undefined answer.
        */
        if (other.length > 0) {
          selected.push(`${other} (user's own answer)`);
        }
        formatted = `Question: ${question.question}\n\nSelected: ${selected.join(", ")}`;
        break;
      }
      formatted = `Question: ${question.question}\n\nAnswer: ${responseValue}`;
      break;

    case "confirm":
      /*
      FNXC:PlanningInterview 2026-07-01-00:00:
      GitHub #1832 lets Planning Mode confirm questions submit `_other` instead of a boolean. Preserve that user-authored answer for the agent; otherwise history replay would turn missing confirm ids into an unintended "No".
      */
      formatted = other.length > 0
        ? `Question: ${question.question}\n\nAnswer: ${other} (user's own answer)`
        : `Question: ${question.question}\n\nAnswer: ${responseValue === true ? "Yes" : "No"}`;
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

function formatInterviewAnswer(question: PlanningQuestion, responseValue: unknown, other = ""): string {
  switch (question.type) {
    case "text":
      return typeof responseValue === "string" ? responseValue : String(responseValue ?? "");

    case "single_select":
      if (other.length > 0) {
        return `${other} (user's own answer)`;
      }
      if (typeof responseValue === "string") {
        const option = question.options?.find((candidate) => candidate.id === responseValue);
        return option?.label || responseValue;
      }
      return String(responseValue ?? "");

    case "multi_select": {
      const selected = Array.isArray(responseValue) ? responseValue.map((id) => {
        if (typeof id !== "string") {
          return String(id);
        }
        const option = question.options?.find((candidate) => candidate.id === id);
        return option?.label || id;
      }) : [];
      if (other.length > 0) {
        selected.push(`${other} (user's own answer)`);
      }
      return selected.length > 0 ? selected.join(", ") : String(responseValue ?? "");
    }

    case "confirm":
      return other.length > 0 ? `${other} (user's own answer)` : responseValue === true ? "Yes" : "No";

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
    const other = typeof responseRecord?._other === "string" ? responseRecord._other.trim() : "";

    const answerLine = `**Q: ${question.question}**\nA: ${formatInterviewAnswer(question, responseValue, other)}`;
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

  await unpersistSession(sessionId);
}

/**
 * Get session details.
 */
/** Attach live-only route dependencies after session rehydration. */
export async function attachPlanningRuntime(
  sessionId: string,
  options: Pick<PlanningSessionOptions, "ntfyConfig" | "messageStore" | "clarificationEnabled">,
): Promise<void> {
  const session = await getSession(sessionId);
  /*
  FNXC:AgentClarification 2026-07-16-16:15:
  The following mutator owns the authoritative missing-session error. Runtime
  attachment is best-effort so restored live sessions receive current ntfy and
  mailbox dependencies without changing existing route error semantics.
  */
  if (!session) return;
  session.ntfyConfig = options.ntfyConfig;
  session.messageStore = options.messageStore;
  // Persisted session choice wins on resumed sessions; route defaults only fill old rows.
  if (session.clarificationEnabled === undefined) session.clarificationEnabled = options.clarificationEnabled === true;
}

export async function getSession(sessionId: string): Promise<Session | undefined> {
  const inMemory = sessions.get(sessionId);
  if (inMemory) {
    return inMemory;
  }

  if (!_aiSessionStore) {
    return undefined;
  }

  const row = await _aiSessionStore.get(sessionId);
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

  const summary = normalizePlanningSummaryPayload(session.summary, {
    title: session.title || session.initialPlan,
    description: session.initialPlan,
  });
  session.summary = summary;
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
export async function cleanupSession(sessionId: string): Promise<void> {
  cleanupInMemorySession(sessionId);
  await unpersistSession(sessionId);
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
  sessionPersistenceQueues.clear();
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
  const session = await getSession(sessionId);
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
