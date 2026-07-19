/**
 * Milestone and Slice Interview Session Management
 *
 * Manages AI-guided interview sessions for per-milestone and per-slice planning.
 * Uses an AI agent to conduct back-and-forth conversations that
 * produce refined scopes with verification criteria.
 *
 * Architecture mirrors mission-interview.ts but targets individual milestones/slices.
 *
 * Features:
 * - AI agent integration with real-time streaming via SSE
 * - Rate limiting per IP
 * - Session expiration and cleanup
 * - SSE streaming via MilestoneSliceInterviewStreamManager
 * - Unified session type for both milestone and slice interviews
 */

import type { PlanningQuestion, Milestone, Slice, MissionStore, AsyncMissionStore, InterviewState, SlicePlanState, TaskStore } from "@fusion/core";

/**
 * FNXC:MissionStore 2026-06-27-16:10:
 * getMissionStore() now returns MissionStore | AsyncMissionStore (PG backend mode).
 * The target-interview helpers await every store call so milestone/slice planning
 * works against both SQLite and PostgreSQL.
 */
type AnyMissionStore = MissionStore | AsyncMissionStore;
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AiSessionStore, AiSessionRow } from "./ai-session-store.js";
import { SessionEventBuffer, type SessionBufferedEvent } from "./sse-buffer.js";
import { registerBeforeExitCleanup } from "./process-lifecycle.js";
import {
  extractJsonCandidate,
  repairJson,
} from "./mission-interview.js";
import {
  createSessionDiagnostics,
  resetDiagnosticsSink,
  nonfatal,
} from "./ai-session-diagnostics.js";
import { createAbortError, GenerationGuard, isAbortError } from "./ai-session-timeout.js";

// Re-export JSON parsing utilities from mission-interview for external consumers
export {
  parseMissionAgentResponse,
  extractJsonCandidate,
  repairJson,
} from "./mission-interview.js";

/**
 * Shared diagnostics helper for the milestone-slice-interview module.
 * Uses the shared ai-session-diagnostics helper for consistent scoped logging.
 * @see ai-session-diagnostics.ts for the shared contract
 */
const diagnostics = createSessionDiagnostics("milestone-slice-interview");

/**
 * Parse a target interview response (milestone or slice) from the AI agent.
 * Validates the response structure and extracts the typed data.
 */
function parseTargetInterviewResponseImpl(text: string): TargetInterviewResponse {
  const candidate = extractJsonCandidate(text);

  if (!candidate) {
    diagnostics.error("No JSON candidate found in agent response", { inputSnippet: text.slice(0, 500), operation: "parse-json" });
    throw new Error("AI returned no valid JSON. Please try again.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (_parseErr) {
    try {
      const repaired = repairJson(candidate);
      parsed = JSON.parse(repaired);
    } catch (repairErr) {
      diagnostics.error("Failed to parse agent response (repair also failed)", { inputSnippet: candidate.slice(0, 500), operation: "parse-json-repair" });
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
    if (typed.type === "question" && typed.data !== null && typed.data !== undefined) {
      return typed as TargetInterviewResponse;
    }
    if (typed.type === "complete" && typed.data !== null && typeof typed.data === "object") {
      return typed as TargetInterviewResponse;
    }
  }

  diagnostics.error("Invalid response structure from AI", { parsedSnippet: JSON.stringify(parsed).slice(0, 500), operation: "parse-validate" });
  throw new Error("AI returned an invalid response structure. Please try again.");
}

// Export the parse function for tests
export { parseTargetInterviewResponseImpl as parseTargetInterviewResponse };

import { buildSessionSkillContextSync, createFnAgent as engineCreateFnAgent, resolveMcpServersForStore } from "@fusion/engine";
import { createPlanningBoardTools } from "./planning-board-tools.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentResult = any;
type SkillSelectionPluginRunner = Parameters<typeof buildSessionSkillContextSync>[3];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createFnAgent: any = engineCreateFnAgent;

function ensureEngineReady(): Promise<void> {
  return Promise.resolve();
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Session TTL in milliseconds (7 days) */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cleanup interval in milliseconds (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Max interview sessions per IP per hour */
const MAX_SESSIONS_PER_IP_PER_HOUR = 5;

/** Rate limiting window in milliseconds (1 hour) */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Max number of retry attempts when AI returns unparseable output */
const MAX_PARSE_RETRIES = 1;

/**
 * Per-turn generation timeout. Bounds a stalled model stream or hung tool
 * call so the session cannot stay pinned in `generating` indefinitely.
 */
export const GENERATION_TIMEOUT_MS = 120_000;

const generationGuard = new GenerationGuard();

/** Milestone interview system prompt */
export const MILESTONE_INTERVIEW_SYSTEM_PROMPT = `You are a milestone planning assistant for a project management system.

Your job: help users refine the scope of a specific milestone, identify verification criteria, and break it into manageable slices.

## Milestone Context
A milestone represents a major phase or deliverable within a larger mission. Each milestone should have:
- Clear scope and boundaries
- Verification criteria for completion
- Logical slices that can be worked on independently

## Conversation Flow
1. Start by understanding the milestone's purpose within the mission context
2. Ask clarifying questions about scope, timeline, dependencies, priorities
3. Push back on vague objectives — ask for specifics
4. Challenge unrealistic scope — suggest phasing
5. Once you have enough information (typically 3-5 questions), produce the refined plan
6. Help identify slices if not already defined

## Question Types to Use
- "text": Open-ended questions for detailed input
- "single_select": When user must choose one option (e.g., priority, approach)
- "multi_select": When multiple options can apply (e.g., features to include)
- "confirm": Yes/No questions for quick decisions

## Guidelines
- Focus on scope refinement — what should this milestone include/exclude?
- Ask about dependencies on other milestones
- Clarify verification criteria — how do we know this milestone is "done"?
- Help break into slices if the milestone is large
- Each slice should be independently shippable work
- ALWAYS include verification criteria at every level:
  - Milestone: "verification" field — how to confirm this phase is complete
  - Slice: "verification" field — how to confirm this work unit is done

## Board tools
- fn_task_list — list active tasks
- fn_task_show — read a task's full details and PROMPT.md
Use these to avoid duplicating an existing in-flight plan and to anchor your questions against current backlog context.

## Response Format
Always respond with valid JSON in one of these formats:

For questions:
{"type": "question", "data": {"id": "unique-id", "type": "text|single_select|multi_select|confirm", "question": "The question text", "description": "Helpful context", "options": [{"id": "opt1", "label": "Option 1", "description": "Details"}]}}

For completion (when you have enough information):
{"type": "complete", "data": {"title": "Refined milestone title", "description": "Detailed scope description", "planningNotes": "Key planning decisions and context", "verification": "How to confirm this milestone is complete", "slices": [{"title": "Slice title", "description": "What this work unit covers", "verification": "How to confirm this slice is done"}]}}`;

/** Slice interview system prompt */
export const SLICE_INTERVIEW_SYSTEM_PROMPT = `You are a slice planning assistant for a project management system.

Your job: help users refine the scope of a specific slice, identify verification criteria, and break it into features with acceptance criteria.

## Slice Context
A slice represents a focused work unit within a milestone that can be activated and worked on independently. Each slice should have:
- Clear scope and boundaries
- Verification criteria for completion
- Specific features with acceptance criteria

## Conversation Flow
1. Start by understanding the slice's purpose within its milestone
2. Ask clarifying questions about scope, technical approach, edge cases
3. Push back on vague objectives — ask for specifics
4. Challenge unrealistic scope — suggest prioritization
5. Once you have enough information (typically 3-5 questions), produce the refined plan
6. Help identify features with clear acceptance criteria

## Question Types to Use
- "text": Open-ended questions for detailed input
- "single_select": When user must choose one option (e.g., technical approach)
- "multi_select": When multiple options can apply (e.g., edge cases to handle)
- "confirm": Yes/No questions for quick decisions

## Guidelines
- Focus on scope refinement — what should this slice include/exclude?
- Ask about technical approach and implementation details
- Clarify edge cases and error handling requirements
- Ask about testing strategy
- Help break into features with clear acceptance criteria
- ALWAYS include verification criteria at every level:
  - Slice: "verification" field — how to confirm this work unit is done
  - Feature: "acceptanceCriteria" field — how to verify this specific deliverable

## Board tools
- fn_task_list — list active tasks
- fn_task_show — read a task's full details and PROMPT.md
Use these to avoid duplicating an existing in-flight plan and to anchor your questions against current backlog context.

## Response Format
Always respond with valid JSON in one of these formats:

For questions:
{"type": "question", "data": {"id": "unique-id", "type": "text|single_select|multi_select|confirm", "question": "The question text", "description": "Helpful context", "options": [{"id": "opt1", "label": "Option 1", "description": "Details"}]}}

For completion (when you have enough information):
{"type": "complete", "data": {"title": "Refined slice title", "description": "Detailed scope description", "planningNotes": "Key planning decisions and technical approach", "verification": "How to confirm this slice is complete", "features": [{"title": "Feature title", "description": "What to build", "acceptanceCriteria": "How to verify this feature works"}]}}`;

// ── Types ───────────────────────────────────────────────────────────────────

/** Target type for interview session */
export type TargetType = "milestone" | "slice";

/** A feature within a slice in the generated plan */
export interface SliceFeature {
  title: string;
  description?: string;
  acceptanceCriteria?: string;
}

/** A slice within a milestone in the generated plan */
export interface MilestoneSlice {
  title: string;
  description?: string;
  verification?: string;
}

/** The complete milestone interview summary produced by the interview */
export interface MilestoneInterviewSummary {
  title?: string;
  description?: string;
  planningNotes?: string;
  verification?: string;
  slices?: MilestoneSlice[];
}

/** The complete slice interview summary produced by the interview */
export interface SliceInterviewSummary {
  title?: string;
  description?: string;
  planningNotes?: string;
  verification?: string;
  features?: SliceFeature[];
}

/** Union type for interview summaries */
export type TargetInterviewSummary = MilestoneInterviewSummary | SliceInterviewSummary;

/** Response from interview: either a question or a completed plan */
export type TargetInterviewResponse =
  | { type: "question"; data: PlanningQuestion }
  | { type: "complete"; data: TargetInterviewSummary };

/** SSE event types for milestone/slice interview streaming */
export type MilestoneSliceInterviewStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "question"; data: PlanningQuestion }
  | { type: "summary"; data: TargetInterviewSummary }
  | { type: "error"; data: string }
  | { type: "complete" };

/** Callback function for streaming events */
export type MilestoneSliceInterviewStreamCallback = (event: MilestoneSliceInterviewStreamEvent, eventId?: number) => void;

interface TargetInterviewHistoryEntry {
  question: PlanningQuestion;
  response: unknown;
  thinkingOutput?: string;
}

/** In-memory interview session for milestones and slices */
interface TargetInterviewSession {
  id: string;
  ip: string;
  targetType: TargetType;
  targetId: string;
  targetTitle: string;
  missionContext?: string;
  history: TargetInterviewHistoryEntry[];
  currentQuestion?: PlanningQuestion;
  summary?: TargetInterviewSummary;
  /** Last terminal error for retry UX */
  error?: string;
  agent?: AgentResult;
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

const sessions = new Map<string, TargetInterviewSession>();
const rateLimits = new Map<string, RateLimitEntry>();

// ── AI Session Persistence ────────────────────────────────────────────────

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

  // Abort any in-flight generation so prompt() rejects promptly.
  generationGuard.stop(sessionId);

  if (session.agent) {
    try { session.agent.session.dispose?.(); } catch { /* ignore */ }
    session.agent = undefined;
  }

  milestoneSliceInterviewStreamManager.cleanupSession(sessionId);
  sessions.delete(sessionId);
  return true;
}

function setTargetSessionError(session: TargetInterviewSession, message: string): void {
  session.error = message;
  session.updatedAt = new Date();
  persistSession(session, "error", message);
  milestoneSliceInterviewStreamManager.broadcast(session.id, {
    type: "error",
    data: message,
  });
}

/**
 * Manually abort an in-flight milestone/slice interview generation.
 * Returns true if a generation was active and got aborted.
 */
export function stopMilestoneSliceInterviewGeneration(sessionId: string): boolean {
  return generationGuard.stop(sessionId);
}

function getSessionType(targetType: TargetType): "milestone_interview" | "slice_interview" {
  return targetType === "milestone" ? "milestone_interview" : "slice_interview";
}

function persistSession(session: TargetInterviewSession, status: "generating" | "awaiting_input" | "complete" | "error", error?: string): void {
  if (!_aiSessionStore) return;
  const row: AiSessionRow = {
    id: session.id,
    type: getSessionType(session.targetType),
    status,
    title: session.targetTitle.slice(0, 120),
    inputPayload: JSON.stringify({
      ip: session.ip,
      targetType: session.targetType,
      targetId: session.targetId,
      targetTitle: session.targetTitle,
      missionContext: session.missionContext,
    }),
    conversationHistory: JSON.stringify(session.history),
    currentQuestion: session.currentQuestion ? JSON.stringify(session.currentQuestion) : null,
    result: session.summary ? JSON.stringify(session.summary) : null,
    thinkingOutput: session.thinkingOutput,
    error: error ?? null,
    projectId: null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: new Date().toISOString(),
  };
  _aiSessionStore.upsert(row).catch(() => { /* best-effort persistence */ });
}

function persistThinking(sessionId: string, thinkingOutput: string): void {
  if (!_aiSessionStore) return;
  _aiSessionStore.updateThinking(sessionId, thinkingOutput);
}

function unpersistSession(sessionId: string): void {
  if (!_aiSessionStore) return;
  void _aiSessionStore.delete(sessionId);
}

function buildSessionFromRow(row: AiSessionRow): TargetInterviewSession {
  const payload = safeParseJson<{
    ip?: string;
    targetType?: TargetType;
    targetId?: string;
    targetTitle?: string;
    missionContext?: string;
  }>(
    row.inputPayload,
    {},
    { throwOnError: true, fieldName: "inputPayload" },
  );

  const createdAt = new Date(row.createdAt);
  const updatedAt = new Date(row.updatedAt);

  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())) {
    throw new Error("Invalid session timestamps");
  }

  return {
    id: row.id,
    ip: payload.ip ?? "",
    targetType: payload.targetType ?? "milestone",
    targetId: payload.targetId ?? "",
    targetTitle: payload.targetTitle ?? row.title,
    missionContext: payload.missionContext,
    history: safeParseJson<TargetInterviewHistoryEntry[]>(
      row.conversationHistory,
      [],
      { throwOnError: true, fieldName: "conversationHistory" },
    ),
    currentQuestion: row.currentQuestion
      ? (safeParseJson<PlanningQuestion | null>(row.currentQuestion, null, {
          throwOnError: true,
          fieldName: "currentQuestion",
        }) ?? undefined)
      : undefined,
    summary: row.result
      ? (safeParseJson<TargetInterviewSummary | null>(row.result, null, {
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

export async function rehydrateFromStore(store: AiSessionStore): Promise<number> {
  let rows: AiSessionRow[] = [];

  try {
    rows = (await store.listRecoverable()).filter(
      (row) => row.type === "milestone_interview" || row.type === "slice_interview"
    );
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

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.updatedAt.getTime() > SESSION_TTL_MS) {
      cleanupInMemorySession(id);
    }
  }
  for (const [ip, entry] of rateLimits) {
    if (now - entry.firstRequestAt.getTime() > RATE_LIMIT_WINDOW_MS) {
      rateLimits.delete(ip);
    }
  }
}

const cleanupInterval = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
cleanupInterval.unref?.();
registerBeforeExitCleanup(() => clearInterval(cleanupInterval));

// ── Stream Manager ──────────────────────────────────────────────────────────

export class MilestoneSliceInterviewStreamManager extends EventEmitter {
  private readonly sessions = new Map<string, Set<MilestoneSliceInterviewStreamCallback>>();
  private readonly buffers = new Map<string, SessionEventBuffer>();

  constructor(private readonly bufferSize = 100) {
    super();
  }

  subscribe(sessionId: string, callback: MilestoneSliceInterviewStreamCallback): () => void {
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

  broadcast(sessionId: string, event: MilestoneSliceInterviewStreamEvent): number {
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

  getBufferedEvents(sessionId: string, sinceId: number): SessionBufferedEvent[] {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return [];
    return buffer.getEventsSince(sinceId);
  }

  hasSubscribers(sessionId: string): boolean {
    const callbacks = this.sessions.get(sessionId);
    return callbacks !== undefined && callbacks.size > 0;
  }

  cleanupSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.buffers.delete(sessionId);
  }

  reset(): void {
    this.sessions.clear();
    this.buffers.clear();
    this.removeAllListeners();
  }
}

export const milestoneSliceInterviewStreamManager = new MilestoneSliceInterviewStreamManager();

// ── Rate Limiting ───────────────────────────────────────────────────────────

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry) {
    rateLimits.set(ip, { count: 1, firstRequestAt: new Date() });
    return true;
  }

  if (now - entry.firstRequestAt.getTime() > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(ip, { count: 1, firstRequestAt: new Date() });
    return true;
  }

  if (entry.count >= MAX_SESSIONS_PER_IP_PER_HOUR) {
    return false;
  }

  entry.count++;
  return true;
}

export function getRateLimitResetTime(ip: string): Date | null {
  const entry = rateLimits.get(ip);
  if (!entry) return null;
  return new Date(entry.firstRequestAt.getTime() + RATE_LIMIT_WINDOW_MS);
}

// ── Response Formatting ──────────────────────────────────────────────────────

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
      GitHub #1794 requires milestone/slice Other-only single-select answers to reach the agent as the user's own answer rather than an undefined fallback or unwanted provided option.
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
        Milestone/slice multi-select Other answers are additive context; append the free-text answer to selected labels and keep Other-only payloads explicit for the agent.
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

function disposeAgentForRetry(session: TargetInterviewSession): void {
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

/*
FNXC:AiSessionCancellation 2026-07-13-00:10:
guard.run()'s onAbort teardown fires for EVERY abort cause, including "displaced" (a re-entrant
generationGuard.run() call for the same session id triggers cancelInternal("displaced") on the
prior entry before the new op runs). Retry flows call disposeAgentForRetry(session) themselves and
then assign a brand-new session.agent BEFORE the retry's own generationGuard.run() call displaces
the stale (already-forgotten) entry from session creation/history-replay. If the stale entry's
onAbort teardown reads session.agent dynamically at teardown time (as disposeAgentForRetry does),
it disposes the FRESH agent the retry just installed — not the stale one — and the retry's own
operation then crashes on `session.agent!` being undefined. Capture the exact agent instance a
generation started with and only tear down / clear that specific instance, so a later displacement
can never dispose an agent installed by a newer call.
*/
function disposeAgentGeneration(session: TargetInterviewSession, agent: AgentResult | undefined): void {
  if (!agent) {
    return;
  }

  nonfatal(
    () => agent.session.dispose?.(),
    diagnostics,
    "Error disposing agent for retry",
    { sessionId: session.id, operation: "dispose-retry" }
  );

  if (session.agent === agent) {
    session.agent = undefined;
  }
}

// ── AI Agent Integration ───────────────────────────────────────────────────

function getSystemPrompt(targetType: TargetType): string {
  return targetType === "milestone" ? MILESTONE_INTERVIEW_SYSTEM_PROMPT : SLICE_INTERVIEW_SYSTEM_PROMPT;
}

export async function createTargetInterviewAgent(
  session: TargetInterviewSession,
  rootDir: string,
  store: TaskStore,
  pluginRunner?: SkillSelectionPluginRunner,
): Promise<AgentResult> {
  await ensureEngineReady();
  const skillContext = buildSessionSkillContextSync(null, "executor", rootDir, pluginRunner);

  /*
  FNXC:McpConfig 2026-06-26-00:00:
  Milestone and slice interviews already receive a TaskStore for planning-board tools; forward configured MCP servers so this readonly agent-work surface matches mission/planning coverage without logging resolved secrets.

  FNXC:McpConfig 2026-06-29-00:00:
  Milestone and slice interviews opt into MCP tools explicitly because they are planning-context lanes; other read-only sessions still skip MCP unless they make the same reviewed policy choice.
  */
  const mcpServers = (await resolveMcpServersForStore(store)).servers;

  return createFnAgent({
    cwd: rootDir,
    systemPrompt: getSystemPrompt(session.targetType),
    tools: "readonly",
    mcpServers,
    allowMcpToolsInReadonly: true,
    customTools: [...createPlanningBoardTools(store)],
    /*
    FNXC:InterviewSkills 2026-06-17-21:42:
    Milestone and slice interview agents are model-only tool-loop sessions, so they must request executor role-fallback skills plus enabled plugin skills such as ce-debug instead of creating skill-less dashboard sessions.
    */
    ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    onThinking: (delta: string) => {
      session.thinkingOutput += delta;
      persistThinking(session.id, session.thinkingOutput);
      milestoneSliceInterviewStreamManager.broadcast(session.id, {
        type: "thinking",
        data: delta,
      });
    },
    onText: (delta: string) => {
      session.thinkingOutput += delta;
    },
  });
}

function formatTargetInterviewHistoryAnswer(question: PlanningQuestion, responseValue: unknown, other: string): string {
  switch (question.type) {
    case "single_select": {
      if (other.length > 0) {
        return `${other} (user's own answer)`;
      }
      if (typeof responseValue === "string") {
        const option = question.options?.find((candidate) => candidate.id === responseValue);
        return option?.label || responseValue;
      }
      return String(responseValue ?? "");
    }
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
      return responseValue === true ? "Yes" : "No";
    case "text":
      return typeof responseValue === "string" ? responseValue : String(responseValue ?? "");
    default:
      return JSON.stringify(responseValue ?? null);
  }
}

export function formatInterviewHistory(
  history: Array<{ question: PlanningQuestion; response: unknown }>,
): string {
  if (history.length === 0) {
    return "";
  }

  return history
    .map(({ question, response }) => {
      const responseRecord =
        response && typeof response === "object" && !Array.isArray(response)
          ? (response as Record<string, unknown>)
          : undefined;
      const responseValue = responseRecord ? responseRecord[question.id] : response;
      const comment = typeof responseRecord?._comment === "string" ? responseRecord._comment.trim() : "";
      const other = typeof responseRecord?._other === "string" ? responseRecord._other.trim() : "";

      const lines = [
        `Q: ${question.question}`,
        `A: ${formatTargetInterviewHistoryAnswer(question, responseValue, other)}`,
      ];

      if (comment.length > 0) {
        lines.push(`Comment: ${comment}`);
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

async function ensureInterviewAgent(
  session: TargetInterviewSession,
  rootDir: string | undefined,
  store: TaskStore | undefined,
  historyForReplay: Array<{ question: PlanningQuestion; response: unknown }>,
  pluginRunner?: SkillSelectionPluginRunner,
): Promise<void> {
  if (session.agent) {
    return;
  }

  if (!rootDir) {
    throw new TargetInvalidSessionStateError(
      "AI agent not available for this session and cannot be resumed without project context"
    );
  }

  if (!store) {
    throw new TargetInvalidSessionStateError(
      "AI agent not available for this session and cannot be resumed without task store context",
    );
  }

  session.agent = await createTargetInterviewAgent(session, rootDir, store, pluginRunner);

  if (historyForReplay.length === 0) {
    return;
  }

  const historySummary = formatInterviewHistory(historyForReplay);
  if (!historySummary) {
    return;
  }

  const replayAgent = session.agent;
  await generationGuard.run(
    session.id,
    GENERATION_TIMEOUT_MS,
    {
      onTimeout: () => setTargetSessionError(
        session,
        "AI generation timed out while restoring context. You can retry or start a new session.",
      ),
      onUserStop: () => setTargetSessionError(
        session,
        "Generation stopped by user. You can retry or start a new session.",
      ),
      onAbort: () => disposeAgentGeneration(session, replayAgent),
    },
    async (abortSignal) => {
      /*
      FNXC:AiSessionCancellation 2026-07-13-00:00:
      FN-7951 requires every milestone/slice interview prompt, including history replay, to receive the generation AbortSignal. Promise.race only stops the caller from awaiting; signal forwarding plus guard-level session teardown is the cancellation contract.
      */
      if (abortSignal.aborted) {
        throw createAbortError();
      }
      await session.agent!.session.prompt(
        [
          "Previous conversation summary:",
          historySummary,
          "Use this context when handling the next user response.",
        ].join("\n\n"),
        { signal: abortSignal },
      );
      if (abortSignal.aborted) {
        throw createAbortError();
      }
    },
  );
}

/**
 * Initialize the AI agent for a session and start the first turn.
 */
async function initializeAgent(
  session: TargetInterviewSession,
  rootDir: string,
  store: TaskStore,
  pluginRunner?: SkillSelectionPluginRunner,
): Promise<void> {
  try {
    session.agent = await createTargetInterviewAgent(session, rootDir, store, pluginRunner);
    session.updatedAt = new Date();

    // Send initial message to get first question
    await continueAgentConversation(
      session,
      `I want to refine the scope for this ${session.targetType}: "${session.targetTitle}".` +
      (session.missionContext ? `\n\nMission context: ${session.missionContext}` : "") +
      ` Interview me to understand what you need, then produce a refined plan.`,
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Failed to initialize AI agent";
    diagnostics.errorFromException("Agent initialization error for session", err, { sessionId: session.id, operation: "initialize-agent" });
    session.error = errorMessage;
    session.updatedAt = new Date();
    persistSession(session, "error", errorMessage);
    milestoneSliceInterviewStreamManager.broadcast(session.id, {
      type: "error",
      data: errorMessage,
    });
  }
}

/**
 * Continue the AI conversation with a user message.
 * Includes bounded recovery: one retry on parse failure.
 */
async function continueAgentConversation(session: TargetInterviewSession, message: string): Promise<void> {
  if (!session.agent) {
    throw new TargetInvalidSessionStateError("AI agent not initialized");
  }

  const generationAgent = session.agent;
  try {
    await generationGuard.run(
      session.id,
      GENERATION_TIMEOUT_MS,
      {
        onTimeout: () => setTargetSessionError(
          session,
          "AI generation timed out. You can retry or start a new session.",
        ),
        onUserStop: () => setTargetSessionError(
          session,
          "Generation stopped by user. You can retry or start a new session.",
        ),
        onAbort: () => disposeAgentGeneration(session, generationAgent),
      },
      async (abortSignal) => {
        const agent = session.agent!;
        session.thinkingOutput = "";

        /*
        FNXC:AiSessionCancellation 2026-07-13-00:00:
        Milestone/slice interview turns and parse-retry prompts must pass the active AbortSignal to prompt() and short-circuit after abort. The GenerationGuard also tears down the agent session because provider SDKs may ignore the signal.
        */
        if (abortSignal.aborted) {
          throw createAbortError();
        }
        await agent.session.prompt(message, { signal: abortSignal });
        if (abortSignal.aborted) {
          throw createAbortError();
        }

        // Get the response text from the agent's state
        interface AgentMessage {
          role: string;
          content?: string | Array<{ type: string; text: string }>;
        }
        const lastMessage = (agent.session.state.messages as AgentMessage[])
          .filter((m: AgentMessage) => m.role === "assistant")
          .pop();

        let responseText = session.thinkingOutput;
        if (lastMessage?.content) {
          if (typeof lastMessage.content === "string") {
            responseText = lastMessage.content;
          } else if (Array.isArray(lastMessage.content)) {
            responseText = lastMessage.content
              .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
              .map((c: { type: string; text: string }) => c.text)
              .join("");
          }
        }

        // Parse with retry using the target interview parser
        let parsed: TargetInterviewResponse | undefined;
        let lastError: Error | undefined;

        for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
          try {
            parsed = parseTargetInterviewResponseImpl(responseText);
            break;
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));

            if (attempt < MAX_PARSE_RETRIES) {
              diagnostics.warn(
                "Parse attempt failed, requesting reformat",
                { sessionId: session.id, attempt: attempt + 1, operation: "parse-retry" }
              );
              try {
                session.thinkingOutput = "";
                if (abortSignal.aborted) {
                  throw createAbortError();
                }
                await agent.session.prompt(
                  "Your previous response could not be parsed as JSON. " +
                  'Please respond with ONLY a valid JSON object: either {"type":"question","data":{...}} ' +
                  'or {"type":"complete","data":{"title":"...","description":"...","planningNotes":"...","verification":"..."}}' +
                  ". No markdown, no explanation, just the JSON.",
                  { signal: abortSignal },
                );
                if (abortSignal.aborted) {
                  throw createAbortError();
                }

                const retryMessage = (agent.session.state.messages as AgentMessage[])
                  .filter((m: AgentMessage) => m.role === "assistant")
                  .pop();

                let retryText = session.thinkingOutput;
                if (retryMessage?.content) {
                  if (typeof retryMessage.content === "string") {
                    retryText = retryMessage.content;
                  } else if (Array.isArray(retryMessage.content)) {
                    retryText = retryMessage.content
                      .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
                      .map((c: { type: string; text: string }) => c.text)
                      .join("");
                  }
                }
                responseText = retryText;
              } catch (retryErr) {
                if (isAbortError(retryErr)) {
                  throw retryErr;
                }
                diagnostics.errorFromException("Retry prompt failed for session", retryErr, { sessionId: session.id, operation: "retry-prompt" });
                break;
              }
            }
          }
        }

        if (!parsed) {
          const errorMsg = `${lastError?.message || "Failed to parse AI response"} You can try responding again or start a new session.`;
          diagnostics.error(
            "All parse attempts exhausted for session",
            { sessionId: session.id, message: errorMsg, operation: "parse-exhausted" }
          );
          setTargetSessionError(session, errorMsg);
          return;
        }

        if (parsed.type === "question") {
          session.currentQuestion = parsed.data;
          session.error = undefined;
          session.lastGeneratedThinking = session.thinkingOutput;
          session.updatedAt = new Date();
          persistSession(session, "awaiting_input");
          milestoneSliceInterviewStreamManager.broadcast(session.id, {
            type: "question",
            data: parsed.data,
          });
        } else if (parsed.type === "complete") {
          session.summary = parsed.data;
          session.currentQuestion = undefined;
          session.error = undefined;
          session.updatedAt = new Date();
          persistSession(session, "complete");
          milestoneSliceInterviewStreamManager.broadcast(session.id, {
            type: "summary",
            data: parsed.data,
          });
          milestoneSliceInterviewStreamManager.broadcast(session.id, { type: "complete" });
        }
      },
    );
  } catch (err) {
    // Timeout / user-stop already published an error state via the guard
    // handlers. Don't double-broadcast a generic AbortError.
    if (isAbortError(err)) {
      return;
    }
    const errorMessage = err instanceof Error ? err.message : "AI processing failed";
    diagnostics.errorFromException("Agent conversation error for session", err, { sessionId: session.id, operation: "conversation" });
    setTargetSessionError(session, errorMessage);
  }
}

// ── Session Management ──────────────────────────────────────────────────────

/**
 * Create a new milestone/slice interview session with AI agent streaming.
 * Returns sessionId immediately; client connects to SSE to receive events.
 */
export async function createTargetInterviewSession(
  ip: string,
  targetType: TargetType,
  targetId: string,
  targetTitle: string,
  missionContext: string | undefined,
  rootDir: string,
  store: TaskStore,
  pluginRunner?: SkillSelectionPluginRunner,
): Promise<string> {
  if (!checkRateLimit(ip)) {
    const resetTime = getRateLimitResetTime(ip);
    throw new RateLimitError(
      `Rate limit exceeded. Maximum ${MAX_SESSIONS_PER_IP_PER_HOUR} sessions per hour. ` +
        `Reset at ${resetTime?.toISOString() || "unknown"}`
    );
  }

  const sessionId = randomUUID();

  const session: TargetInterviewSession = {
    id: sessionId,
    ip,
    targetType,
    targetId,
    targetTitle,
    missionContext,
    history: [],
    thinkingOutput: "",
    lastGeneratedThinking: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  sessions.set(sessionId, session);
  persistSession(session, "generating");

  // Initialize AI agent in background
  initializeAgent(session, rootDir, store, pluginRunner).catch((err) => {
    diagnostics.errorFromException("Failed to initialize agent for session", err, { sessionId, operation: "initialize-agent" });
    persistSession(session, "error", err.message || "Failed to initialize AI agent");
    milestoneSliceInterviewStreamManager.broadcast(sessionId, {
      type: "error",
      data: err.message || "Failed to initialize AI agent",
    });
  });

  return sessionId;
}

/**
 * Submit a response to the current question.
 */
export async function submitTargetInterviewResponse(
  sessionId: string,
  responses: Record<string, unknown>,
  rootDir?: string,
  store?: TaskStore,
  pluginRunner?: SkillSelectionPluginRunner,
): Promise<TargetInterviewResponse> {
  const session = await getTargetInterviewSession(sessionId);
  if (!session) {
    throw new TargetSessionNotFoundError(`Interview session ${sessionId} not found or expired`);
  }

  /*
  FNXC:AiSessionCancellation 2026-07-13-00:10:
  Reject an overlapping submit instead of letting generationGuard.run()'s displaced-abort teardown dispose the shared session.agent out from under this call (see TargetGenerationInProgressError doc).
  */
  if (generationGuard.has(sessionId)) {
    throw new TargetGenerationInProgressError("Generation already in progress for this response");
  }

  if (!session.currentQuestion) {
    throw new TargetInvalidSessionStateError("No active question in session");
  }

  // Record the response
  session.history.push({
    question: session.currentQuestion,
    response: responses,
    thinkingOutput: session.lastGeneratedThinking || "",
  });
  session.error = undefined;
  persistSession(session, "generating");

  if (!session.agent) {
    const replayHistory = session.history.slice(0, -1);
    await ensureInterviewAgent(session, rootDir, store, replayHistory, pluginRunner);
  }

  const message = formatResponseForAgent(session.currentQuestion, responses);
  await continueAgentConversation(session, message);

  if (session.summary) {
    return { type: "complete", data: session.summary };
  }
  if (session.currentQuestion) {
    return { type: "question", data: session.currentQuestion };
  }
  // Fallback — should not happen with a working agent
  return {
    type: "question",
    data: {
      id: "q-fallback",
      type: "text",
      question: "Could you tell me more about what you want to accomplish?",
      description: "The AI is processing your response. Please provide more details.",
    },
  };
}

/**
 * Retry a failed interview session.
 */
export async function retryTargetInterviewSession(
  sessionId: string,
  rootDir: string,
  store?: TaskStore,
  pluginRunner?: SkillSelectionPluginRunner,
): Promise<void> {
  const session = await getTargetInterviewSession(sessionId);
  if (!session) {
    throw new TargetSessionNotFoundError(`Interview session ${sessionId} not found or expired`);
  }

  const persisted = _aiSessionStore ? await _aiSessionStore.get(sessionId) : null;
  if (persisted) {
    const sessionType = getSessionType(session.targetType);
    if (persisted.type !== sessionType) {
      throw new TargetSessionNotFoundError(`Interview session ${sessionId} not found or expired`);
    }
  }

  const inErrorState = persisted ? persisted.status === "error" : Boolean(session.error);
  if (!inErrorState) {
    throw new TargetInvalidSessionStateError(`Interview session ${sessionId} is not in an error state`);
  }

  /*
  FNXC:AiSessionCancellation 2026-07-13-00:10:
  A session can be observed in "error" (persisted status) while its original fire-and-forget
  initializeAgent() first turn is still actually in flight (createTargetInterviewSession never
  awaits it). Retrying while that generation is still registered would race two concurrent
  continueAgentConversation calls over the single shared session.agent slot. Reject cleanly instead,
  matching the mission-interview.ts retryMissionInterviewSession guard for the identical race.
  */
  if (generationGuard.has(sessionId)) {
    throw new TargetGenerationInProgressError("Generation already in progress for this session");
  }

  disposeAgentForRetry(session);

  session.error = undefined;
  session.summary = undefined;
  session.updatedAt = new Date();
  persistSession(session, "generating");

  if (session.history.length === 0) {
    await ensureInterviewAgent(session, rootDir, store, [], pluginRunner);
    await continueAgentConversation(
      session,
      `I want to refine the scope for this ${session.targetType}: "${session.targetTitle}".` +
      (session.missionContext ? `\n\nMission context: ${session.missionContext}` : "") +
      ` Interview me to understand what you need, then produce a refined plan.`,
    );
    return;
  }

  const replayHistory = session.history.slice(0, -1);
  const lastEntry = session.history[session.history.length - 1];

  await ensureInterviewAgent(session, rootDir, store, replayHistory, pluginRunner);
  const replayMessage = formatResponseForAgent(
    lastEntry.question,
    coerceResponseRecord(lastEntry.question, lastEntry.response),
  );
  await continueAgentConversation(session, replayMessage);
}

/**
 * Cancel and cleanup an interview session.
 */
export async function cancelTargetInterviewSession(sessionId: string): Promise<void> {
  const removed = cleanupInMemorySession(sessionId);
  if (!removed) {
    throw new TargetSessionNotFoundError(`Interview session ${sessionId} not found or expired`);
  }

  unpersistSession(sessionId);
}

/**
 * Get session by ID (in-memory or from SQLite).
 */
export async function getTargetInterviewSession(sessionId: string): Promise<TargetInterviewSession | undefined> {
  const inMemory = sessions.get(sessionId);
  if (inMemory) {
    return inMemory;
  }

  if (!_aiSessionStore) {
    return undefined;
  }

  const row = await _aiSessionStore.get(sessionId);
  if (!row || (row.type !== "milestone_interview" && row.type !== "slice_interview")) {
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
 * Get the summary from a completed session.
 */
export async function getTargetInterviewSummary(sessionId: string): Promise<TargetInterviewSummary | undefined> {
  return (await getTargetInterviewSession(sessionId))?.summary;
}

/**
 * Cleanup both in-memory and SQLite.
 */
export function cleanupTargetInterviewSession(sessionId: string): void {
  cleanupInMemorySession(sessionId);
  unpersistSession(sessionId);
}

// ── Apply & Skip ───────────────────────────────────────────────────────────

/**
 * Apply the interview summary to the target (milestone or slice).
 */
export async function applyTargetInterview(
  sessionId: string,
  missionStore: AnyMissionStore
): Promise<Milestone | Slice> {
  const session = await getTargetInterviewSession(sessionId);
  if (!session) {
    throw new TargetSessionNotFoundError(`Interview session ${sessionId} not found or expired`);
  }

  const summary = session.summary;
  if (!summary) {
    throw new TargetInvalidSessionStateError("Interview session has no summary to apply");
  }

  let result: Milestone | Slice;

  if (session.targetType === "milestone") {
    const milestone = await missionStore.getMilestone(session.targetId);
    if (!milestone) {
      throw new TargetSessionNotFoundError(`Milestone ${session.targetId} not found`);
    }

    result = await missionStore.updateMilestone(session.targetId, {
      description: summary.description,
      planningNotes: summary.planningNotes,
      verification: summary.verification,
      interviewState: "completed" as InterviewState,
    });
  } else {
    const slice = await missionStore.getSlice(session.targetId);
    if (!slice) {
      throw new TargetSessionNotFoundError(`Slice ${session.targetId} not found`);
    }

    result = await missionStore.updateSlice(session.targetId, {
      description: summary.description,
      planningNotes: summary.planningNotes,
      verification: summary.verification,
      planState: "planned" as SlicePlanState,
    });
  }

  // Cleanup the interview session
  cleanupTargetInterviewSession(sessionId);

  return result;
}

/**
 * Skip the interview and apply mission-level context directly.
 */
export async function skipTargetInterview(
  targetType: TargetType,
  targetId: string,
  missionStore: AnyMissionStore
): Promise<Milestone | Slice> {
  let result: Milestone | Slice;

  if (targetType === "milestone") {
    const milestone = await missionStore.getMilestone(targetId);
    if (!milestone) {
      throw new TargetSessionNotFoundError(`Milestone ${targetId} not found`);
    }

    // Get mission context for the skip message
    const mission = await missionStore.getMission(milestone.missionId);
    const contextMessage = mission
      ? `Planned using mission-level context (no per-milestone interview). Mission: "${mission.title}". ${mission.description || ""}`
      : "Planned using mission-level context (no per-milestone interview)";

    result = await missionStore.updateMilestone(targetId, {
      planningNotes: contextMessage,
      interviewState: "completed" as InterviewState,
    });
  } else {
    const slice = await missionStore.getSlice(targetId);
    if (!slice) {
      throw new TargetSessionNotFoundError(`Slice ${targetId} not found`);
    }

    // Get mission context for the skip message
    const milestone = await missionStore.getMilestone(slice.milestoneId);
    const milestoneTitle = milestone?.title;
    const mission = milestone ? await missionStore.getMission(milestone.missionId) : undefined;
    const contextMessage = mission
      ? `Planned using mission-level context (no per-slice interview). Mission: "${mission.title}". Milestone: "${milestoneTitle}". ${mission.description || ""}`
      : milestoneTitle
        ? `Planned using mission-level context (no per-slice interview). Milestone: "${milestoneTitle}".`
        : "Planned using mission-level context (no per-slice interview)";

    result = await missionStore.updateSlice(targetId, {
      planningNotes: contextMessage,
      planState: "planned" as SlicePlanState,
    });
  }

  return result;
}

// ── Custom Errors ───────────────────────────────────────────────────────────

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class TargetSessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetSessionNotFoundError";
  }
}

export class TargetInvalidSessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetInvalidSessionStateError";
  }
}

/*
FNXC:AiSessionCancellation 2026-07-13-00:10:
FN-7951's onAbort teardown disposes the shared session.agent on every abort cause, including "displaced" (a re-entrant generationGuard.run() call for the same session id). The continued-conversation operation reads session.agent synchronously at the start of its op closure, so a second overlapping call for the same session would observe session.agent === undefined (cleared by the first call's displaced-abort teardown) and crash with a TypeError instead of a clean, recoverable error. Reject overlapping generations up front so the shared agent handle is never raced.
*/
export class TargetGenerationInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetGenerationInProgressError";
  }
}

/**
 * Reset all milestone/slice interview state. Used for testing only.
 */
export function __resetMilestoneSliceInterviewState(): void {
  for (const [id] of sessions) {
    cleanupInMemorySession(id);
  }
  sessions.clear();
  rateLimits.clear();
  milestoneSliceInterviewStreamManager.reset();
  generationGuard.reset();

  if (_aiSessionStore && _aiSessionDeletedListener) {
    _aiSessionStore.off("ai_session:deleted", _aiSessionDeletedListener);
  }
  _aiSessionDeletedListener = undefined;
  _aiSessionStore = undefined;

  // Reset diagnostics sink to default
  resetDiagnosticsSink();
}
