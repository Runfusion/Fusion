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

import type { PlanningQuestion, Milestone, Slice, MissionStore, InterviewState, SlicePlanState } from "@fusion/core";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AiSessionStore, AiSessionRow } from "./ai-session-store.js";
import { SessionEventBuffer, type SessionBufferedEvent } from "./sse-buffer.js";
import {
  parseMissionAgentResponse,
  extractJsonCandidate,
  repairJson,
} from "./mission-interview.js";

// Re-export JSON parsing utilities from mission-interview for external consumers
export {
  parseMissionAgentResponse,
  extractJsonCandidate,
  repairJson,
} from "./mission-interview.js";

/**
 * Parse a target interview response (milestone or slice) from the AI agent.
 * Validates the response structure and extracts the typed data.
 */
function parseTargetInterviewResponseImpl(text: string): TargetInterviewResponse {
  const candidate = extractJsonCandidate(text);

  if (!candidate) {
    console.error("[milestone-slice-interview] No JSON candidate found in agent response:", text.slice(0, 500));
    throw new Error("AI returned no valid JSON. Please try again.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (parseErr) {
    try {
      const repaired = repairJson(candidate);
      parsed = JSON.parse(repaired);
    } catch (repairErr) {
      console.error("[milestone-slice-interview] Failed to parse agent response:", candidate.slice(0, 500));
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

  console.error("[milestone-slice-interview] Invalid response structure:", JSON.stringify(parsed).slice(0, 500));
  throw new Error("AI returned an invalid response structure. Please try again.");
}

// Export the parse function for tests
export { parseTargetInterviewResponseImpl as parseTargetInterviewResponse };

// Dynamic import for @fusion/engine to avoid resolution issues in test environment
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentResult = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createKbAgent: any;

async function initEngine() {
  if (!createKbAgent) {
    try {
      const engineModule = "@fusion/engine";
      const engine = await import(/* @vite-ignore */ engineModule);
      createKbAgent = engine.createKbAgent;
    } catch {
      // Allow failure in test environments
      createKbAgent = undefined;
    }
  }
}

const engineReady = initEngine();

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

  if (session.agent) {
    try { session.agent.session.dispose?.(); } catch { /* ignore */ }
    session.agent = undefined;
  }

  milestoneSliceInterviewStreamManager.cleanupSession(sessionId);
  sessions.delete(sessionId);
  return true;
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
    lockedByTab: null,
    lockedAt: null,
  };
  _aiSessionStore.upsert(row);
}

function persistThinking(sessionId: string, thinkingOutput: string): void {
  if (!_aiSessionStore) return;
  _aiSessionStore.updateThinking(sessionId, thinkingOutput);
}

function unpersistSession(sessionId: string): void {
  if (!_aiSessionStore) return;
  _aiSessionStore.delete(sessionId);
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

export function rehydrateFromStore(store: AiSessionStore): number {
  let rows: AiSessionRow[] = [];

  try {
    rows = store.listRecoverable().filter(
      (row) => row.type === "milestone_interview" || row.type === "slice_interview"
    );
  } catch (error) {
    console.error("[milestone-slice-interview] Failed to list recoverable sessions:", error);
    return 0;
  }

  let rehydrated = 0;
  for (const row of rows) {
    try {
      const session = buildSessionFromRow(row);
      sessions.set(session.id, session);
      rehydrated += 1;
    } catch (error) {
      console.error(`[milestone-slice-interview] Failed to rehydrate session ${row.id}:`, error);
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
process.on("beforeExit", () => clearInterval(cleanupInterval));

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
      try {
        callback(event, eventId);
      } catch (err) {
        console.error(`[milestone-slice-interview] Error broadcasting to client for session ${sessionId}:`, err);
      }
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
function formatResponseForAgent(
  question: PlanningQuestion,
  responses: Record<string, unknown>
): string {
  const responseValue = responses[question.id];

  switch (question.type) {
    case "text":
      return `Question: ${question.question}\n\nAnswer: ${responseValue}`;
    case "single_select":
      if (typeof responseValue === "string") {
        const option = question.options?.find((o) => o.id === responseValue);
        return `Question: ${question.question}\n\nSelected: ${option?.label || responseValue}`;
      }
      return `Question: ${question.question}\n\nAnswer: ${responseValue}`;
    case "multi_select":
      if (Array.isArray(responseValue)) {
        const selected = responseValue.map((id) => {
          const option = question.options?.find((o) => o.id === id);
          return option?.label || id;
        });
        return `Question: ${question.question}\n\nSelected: ${selected.join(", ")}`;
      }
      return `Question: ${question.question}\n\nAnswer: ${responseValue}`;
    case "confirm":
      return `Question: ${question.question}\n\nAnswer: ${responseValue === true ? "Yes" : "No"}`;
    default:
      return `Question: ${question.question}\n\nAnswer: ${JSON.stringify(responseValue)}`;
  }
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

  try {
    session.agent.session.dispose?.();
  } catch (error) {
    console.error(`[milestone-slice-interview] Error disposing agent for retry in session ${session.id}:`, error);
  }

  session.agent = undefined;
}

// ── AI Agent Integration ───────────────────────────────────────────────────

function getSystemPrompt(targetType: TargetType): string {
  return targetType === "milestone" ? MILESTONE_INTERVIEW_SYSTEM_PROMPT : SLICE_INTERVIEW_SYSTEM_PROMPT;
}

async function createTargetInterviewAgent(
  session: TargetInterviewSession,
  rootDir: string,
): Promise<AgentResult> {
  await engineReady;

  return createKbAgent({
    cwd: rootDir,
    systemPrompt: getSystemPrompt(session.targetType),
    tools: "readonly",
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

function formatInterviewHistory(
  history: Array<{ question: PlanningQuestion; response: unknown }>,
): string {
  if (history.length === 0) {
    return "";
  }

  return history
    .map(({ question, response }) => {
      const responseValue =
        response && typeof response === "object" && !Array.isArray(response)
          ? (response as Record<string, unknown>)[question.id]
          : response;

      return [
        `Q: ${question.question}`,
        `A: ${typeof responseValue === "string" ? responseValue : JSON.stringify(responseValue ?? null)}`,
      ].join("\n");
    })
    .join("\n\n");
}

async function ensureInterviewAgent(
  session: TargetInterviewSession,
  rootDir: string | undefined,
  historyForReplay: Array<{ question: PlanningQuestion; response: unknown }>,
): Promise<void> {
  if (session.agent) {
    return;
  }

  if (!rootDir) {
    throw new TargetInvalidSessionStateError(
      "AI agent not available for this session and cannot be resumed without project context"
    );
  }

  session.agent = await createTargetInterviewAgent(session, rootDir);

  if (historyForReplay.length === 0) {
    return;
  }

  const historySummary = formatInterviewHistory(historyForReplay);
  if (!historySummary) {
    return;
  }

  await session.agent.session.prompt(
    [
      "Previous conversation summary:",
      historySummary,
      "Use this context when handling the next user response.",
    ].join("\n\n"),
  );
}

/**
 * Initialize the AI agent for a session and start the first turn.
 */
async function initializeAgent(session: TargetInterviewSession, rootDir: string): Promise<void> {
  try {
    session.agent = await createTargetInterviewAgent(session, rootDir);
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
    console.error(`[milestone-slice-interview] Agent initialization error for session ${session.id}:`, err);
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

  try {
    session.thinkingOutput = "";

    await session.agent.session.prompt(message);

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
          console.warn(
            `[milestone-slice-interview] Parse attempt ${attempt + 1} failed for session ${session.id}, requesting reformat`
          );
          try {
            session.thinkingOutput = "";
            await session.agent.session.prompt(
              "Your previous response could not be parsed as JSON. " +
              'Please respond with ONLY a valid JSON object: either {"type":"question","data":{...}} ' +
              'or {"type":"complete","data":{"title":"...","description":"...","planningNotes":"...","verification":"..."}}' +
              ". No markdown, no explanation, just the JSON."
            );

            const retryMessage = (session.agent.session.state.messages as AgentMessage[])
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
            console.error(`[milestone-slice-interview] Retry prompt failed for session ${session.id}:`, retryErr);
            break;
          }
        }
      }
    }

    if (!parsed) {
      const errorMsg = `${lastError?.message || "Failed to parse AI response"} You can try responding again or start a new session.`;
      console.error(`[milestone-slice-interview] All parse attempts exhausted for session ${session.id}:`, errorMsg);
      session.error = errorMsg;
      session.updatedAt = new Date();
      persistSession(session, "error", errorMsg);
      milestoneSliceInterviewStreamManager.broadcast(session.id, {
        type: "error",
        data: errorMsg,
      });
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
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "AI processing failed";
    console.error(`[milestone-slice-interview] Agent conversation error for session ${session.id}:`, err);
    session.error = errorMessage;
    session.updatedAt = new Date();
    persistSession(session, "error", errorMessage);
    milestoneSliceInterviewStreamManager.broadcast(session.id, {
      type: "error",
      data: errorMessage,
    });
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
  rootDir: string
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
  initializeAgent(session, rootDir).catch((err) => {
    console.error(`[milestone-slice-interview] Failed to initialize agent for session ${sessionId}:`, err);
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
): Promise<TargetInterviewResponse> {
  const session = getTargetInterviewSession(sessionId);
  if (!session) {
    throw new TargetSessionNotFoundError(`Interview session ${sessionId} not found or expired`);
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
    await ensureInterviewAgent(session, rootDir, replayHistory);
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
export async function retryTargetInterviewSession(sessionId: string, rootDir: string): Promise<void> {
  const session = getTargetInterviewSession(sessionId);
  if (!session) {
    throw new TargetSessionNotFoundError(`Interview session ${sessionId} not found or expired`);
  }

  const persisted = _aiSessionStore?.get(sessionId);
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

  disposeAgentForRetry(session);

  session.error = undefined;
  session.summary = undefined;
  session.updatedAt = new Date();
  persistSession(session, "generating");

  if (session.history.length === 0) {
    await ensureInterviewAgent(session, rootDir, []);
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

  await ensureInterviewAgent(session, rootDir, replayHistory);
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
export function getTargetInterviewSession(sessionId: string): TargetInterviewSession | undefined {
  const inMemory = sessions.get(sessionId);
  if (inMemory) {
    return inMemory;
  }

  if (!_aiSessionStore) {
    return undefined;
  }

  const row = _aiSessionStore.get(sessionId);
  if (!row || (row.type !== "milestone_interview" && row.type !== "slice_interview")) {
    return undefined;
  }

  try {
    const restored = buildSessionFromRow(row);
    sessions.set(restored.id, restored);
    return restored;
  } catch (error) {
    console.error(`[milestone-slice-interview] Failed to restore session ${sessionId} from SQLite:`, error);
    return undefined;
  }
}

/**
 * Get the summary from a completed session.
 */
export function getTargetInterviewSummary(sessionId: string): TargetInterviewSummary | undefined {
  return getTargetInterviewSession(sessionId)?.summary;
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
export function applyTargetInterview(
  sessionId: string,
  missionStore: MissionStore
): Milestone | Slice {
  const session = getTargetInterviewSession(sessionId);
  if (!session) {
    throw new TargetSessionNotFoundError(`Interview session ${sessionId} not found or expired`);
  }

  const summary = session.summary;
  if (!summary) {
    throw new TargetInvalidSessionStateError("Interview session has no summary to apply");
  }

  let result: Milestone | Slice;

  if (session.targetType === "milestone") {
    const milestone = missionStore.getMilestone(session.targetId);
    if (!milestone) {
      throw new TargetSessionNotFoundError(`Milestone ${session.targetId} not found`);
    }

    result = missionStore.updateMilestone(session.targetId, {
      description: summary.description,
      planningNotes: summary.planningNotes,
      verification: summary.verification,
      interviewState: "completed" as InterviewState,
    });
  } else {
    const slice = missionStore.getSlice(session.targetId);
    if (!slice) {
      throw new TargetSessionNotFoundError(`Slice ${session.targetId} not found`);
    }

    result = missionStore.updateSlice(session.targetId, {
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
export function skipTargetInterview(
  targetType: TargetType,
  targetId: string,
  missionStore: MissionStore
): Milestone | Slice {
  let result: Milestone | Slice;

  if (targetType === "milestone") {
    const milestone = missionStore.getMilestone(targetId);
    if (!milestone) {
      throw new TargetSessionNotFoundError(`Milestone ${targetId} not found`);
    }

    // Get mission context for the skip message
    const mission = missionStore.getMission(milestone.missionId);
    const contextMessage = mission
      ? `Planned using mission-level context (no per-milestone interview). Mission: "${mission.title}". ${mission.description || ""}`
      : "Planned using mission-level context (no per-milestone interview)";

    result = missionStore.updateMilestone(targetId, {
      planningNotes: contextMessage,
      interviewState: "completed" as InterviewState,
    });
  } else {
    const slice = missionStore.getSlice(targetId);
    if (!slice) {
      throw new TargetSessionNotFoundError(`Slice ${targetId} not found`);
    }

    // Get mission context for the skip message
    const milestone = missionStore.getMilestone(slice.milestoneId);
    const milestoneTitle = milestone?.title;
    const mission = milestone ? missionStore.getMission(milestone.missionId) : undefined;
    const contextMessage = mission
      ? `Planned using mission-level context (no per-slice interview). Mission: "${mission.title}". Milestone: "${milestoneTitle}". ${mission.description || ""}`
      : milestoneTitle
        ? `Planned using mission-level context (no per-slice interview). Milestone: "${milestoneTitle}".`
        : "Planned using mission-level context (no per-slice interview)";

    result = missionStore.updateSlice(targetId, {
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

  if (_aiSessionStore && _aiSessionDeletedListener) {
    _aiSessionStore.off("ai_session:deleted", _aiSessionDeletedListener);
  }
  _aiSessionDeletedListener = undefined;
  _aiSessionStore = undefined;
}
