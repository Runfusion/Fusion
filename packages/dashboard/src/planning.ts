/**
 * Planning Mode Session Management
 *
 * Manages AI-guided planning sessions for interactive task creation.
 * Sessions are stored in-memory with TTL cleanup.
 * 
 * Features:
 * - AI agent integration via createKbAgent for real-time planning conversations
 * - Streaming via SSE (createSessionWithAgent) and non-streaming (createSession)
 * - Rate limiting per IP
 * - Session expiration and cleanup
 * - JSON response parsing with robust extraction and repair
 */

import type {
  PlanningQuestion,
  PlanningSummary,
  PlanningResponse,
  TaskStore,
} from "@fusion/core";
import type { SubtaskItem } from "./subtask-breakdown.js";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AiSessionStore, AiSessionRow } from "./ai-session-store.js";
import { SessionEventBuffer, type SessionBufferedEvent } from "./sse-buffer.js";

// Dynamic import for @fusion/engine to avoid resolution issues in test environment
// eslint-disable-next-line @typescript-eslint/consistent-type-imports, @typescript-eslint/no-explicit-any
type AgentResult = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createKbAgent: any;

// Initialize the import (this runs in actual server, mocked in tests)
async function initEngine() {
  if (!createKbAgent) {
    try {
      // Use dynamic import with variable to prevent static analysis
      const engineModule = "@fusion/engine";
      const engine = await import(/* @vite-ignore */ engineModule);
      if (!createKbAgent) {
        createKbAgent = engine.createKbAgent;
      }
    } catch {
      // Allow failure in test environments - agent functionality will be stubbed
      if (!createKbAgent) {
        createKbAgent = undefined;
      }
    }
  }
}

// Initialize on module load (will be awaited in actual usage)
const engineReady = initEngine();

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

## Response Format
Always respond with valid JSON in one of these formats:

For questions:
{\n  "type": "question",\n  "data": {\n    "id": "unique-id",\n    "type": "text|single_select|multi_select|confirm",\n    "question": "The question text",\n    "description": "Helpful context",\n    "options": [{"id": "opt1", "label": "Option 1", "description": "Details"}]\n  }\n}

For completion:
{\n  "type": "complete",\n  "data": {\n    "title": "Task title",\n    "description": "Detailed description",\n    "suggestedSize": "S|M|L",\n    "suggestedDependencies": [],\n    "keyDeliverables": ["Item 1", "Item 2"]\n  }\n}`;

/** Session TTL in milliseconds (7 days) */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cleanup interval in milliseconds (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Max planning sessions per IP per hour */
const MAX_SESSIONS_PER_IP_PER_HOUR = 5;

/** Rate limiting window in milliseconds (1 hour) */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

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
  history: PlanningHistoryEntry[];
  currentQuestion?: PlanningQuestion;
  summary?: PlanningSummary;
  /** AI agent session for real-time interaction */
  agent?: AgentResult;
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

  if (session.agent) {
    try {
      session.agent.session.dispose?.();
    } catch (err) {
      console.error(`[planning] Error disposing agent for session ${sessionId}:`, err);
    }
    session.agent = undefined;
  }

  planningStreamManager.cleanupSession(sessionId);
  sessions.delete(sessionId);
  return true;
}

/** Persist the current session state to SQLite (no-op if store not wired). */
function persistSession(session: Session, status: "generating" | "awaiting_input" | "complete" | "error", projectId?: string, error?: string): void {
  if (!_aiSessionStore) return;
  const row: AiSessionRow = {
    id: session.id,
    type: "planning",
    status,
    title: session.initialPlan.slice(0, 120),
    inputPayload: JSON.stringify({ ip: session.ip, initialPlan: session.initialPlan }),
    conversationHistory: JSON.stringify(session.history),
    currentQuestion: session.currentQuestion ? JSON.stringify(session.currentQuestion) : null,
    result: session.summary ? JSON.stringify(session.summary) : null,
    thinkingOutput: session.thinkingOutput,
    error: error ?? null,
    projectId: projectId ?? null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: new Date().toISOString(),
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

function buildSessionFromRow(row: AiSessionRow): Session {
  const payload = safeParseJson<{ ip?: string; initialPlan?: string }>(
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
    initialPlan: payload.initialPlan ?? row.title,
    history: safeParseJson<PlanningHistoryEntry[]>(
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
      ? (safeParseJson<PlanningSummary | null>(row.result, null, {
          throwOnError: true,
          fieldName: "result",
        }) ?? undefined)
      : undefined,
    thinkingOutput: row.thinkingOutput,
    lastGeneratedThinking: row.thinkingOutput || "",
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
    console.error("[planning] Failed to list recoverable sessions:", error);
    return 0;
  }

  let rehydrated = 0;
  for (const row of rows) {
    try {
      const session = buildSessionFromRow(row);
      sessions.set(session.id, session);
      rehydrated += 1;
    } catch (error) {
      console.error(`[planning] Failed to rehydrate session ${row.id}:`, error);
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
    console.log(
      `[planning] Cleanup: removed ${cleanedSessions} sessions, ${cleanedRateLimits} rate limit entries`
    );
  }
}

// Start cleanup interval
const cleanupInterval = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);

// Handle graceful shutdown
process.on("beforeExit", () => {
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
      try {
        callback(event, eventId);
      } catch (err) {
        console.error(`[planning] Error broadcasting to client for session ${sessionId}:`, err);
      }
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
  }

  /**
   * Reset all subscriptions and buffers (test helper).
   */
  reset(): void {
    this.sessions.clear();
    this.buffers.clear();
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
  _store?: TaskStore,
  rootDir?: string
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

  const sessionId = randomUUID();

  const session: Session = {
    id: sessionId,
    ip,
    initialPlan,
    history: [],
    thinkingOutput: "",
    lastGeneratedThinking: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  sessions.set(sessionId, session);
  persistSession(session, "generating");

  // Create AI agent and get the first question
  // Only await engineReady if createKbAgent hasn't been set externally (e.g., via __setCreateKbAgent)
  if (!createKbAgent) {
    await engineReady;
  }

  const agentResult = await createKbAgent({
    cwd: rootDir,
    systemPrompt: PLANNING_SYSTEM_PROMPT,
    tools: "readonly",
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
    content?: string | Array<{ type: string; text: string }>;
  }
  const lastMessage = (session.agent.session.state.messages as AgentMessage[])
    .filter((m: AgentMessage) => m.role === "assistant")
    .pop();

  let responseText = "";
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
              responseText = retryMessage.content
                .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
                .map((c: { type: string; text: string }) => c.text)
                .join("");
            }
          }
        } catch {
          break;
        }
      }
    }
  }

  if (!parsed) {
    // Clean up the session on failure
    sessions.delete(session.id);
    unpersistSession(session.id);
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

/**
 * Create a new planning session with AI agent streaming.
 * This initializes an AI agent that will stream thinking output via SSE.
 * 
 * @param ip - Client IP for rate limiting
 * @param initialPlan - The user's initial plan description
 * @param rootDir - Project root directory for AI agent context
 * @returns Session ID (use with planningStreamManager to receive events)
 */
export async function createSessionWithAgent(
  ip: string,
  initialPlan: string,
  rootDir: string,
  modelProvider?: string,
  modelId?: string,
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
    history: [],
    thinkingOutput: "",
    lastGeneratedThinking: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  sessions.set(sessionId, session);
  persistSession(session, "generating");

  // Initialize AI agent in background - it will stream via planningStreamManager
  initializeAgent(session, rootDir, modelProvider, modelId).catch((err) => {
    console.error(`[planning] Failed to initialize agent for session ${sessionId}:`, err);
    persistSession(session, "error", undefined, err.message || "Failed to initialize AI agent");
    planningStreamManager.broadcast(sessionId, {
      type: "error",
      data: err.message || "Failed to initialize AI agent",
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
  modelProvider?: string,
  modelId?: string,
): Promise<void> {
  try {
    session.agent = await createPlanningAgent(session, rootDir, modelProvider, modelId);
    session.updatedAt = new Date();

    // Send initial message to get first question
    await continueAgentConversation(session, session.initialPlan);
  } catch (err) {
    console.error(`[planning] Agent initialization error for session ${session.id}:`, err);
    planningStreamManager.broadcast(session.id, {
      type: "error",
      data: err instanceof Error ? err.message : "Failed to initialize AI agent",
    });
  }
}

async function createPlanningAgent(
  session: Session,
  rootDir: string,
  modelProvider?: string,
  modelId?: string,
): Promise<AgentResult> {
  // Ensure engine is loaded before using createKbAgent
  await engineReady;

  return createKbAgent({
    cwd: rootDir,
    systemPrompt: PLANNING_SYSTEM_PROMPT,
    tools: "readonly",
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
      // Capture AI response text - will be parsed at end of turn
      session.thinkingOutput += delta;
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
): Promise<void> {
  if (session.agent) {
    return;
  }

  if (!rootDir) {
    throw new InvalidSessionStateError(
      "Planning session has no AI agent and cannot be resumed without project context",
    );
  }

  session.agent = await createPlanningAgent(session, rootDir);

  if (historyForReplay.length === 0) {
    return;
  }

  const contextMessage = buildHistoryReplayPrompt(historyForReplay);
  await session.agent.session.prompt(contextMessage);
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
async function continueAgentConversation(session: Session, message: string): Promise<void> {
  if (!session.agent) {
    throw new InvalidSessionStateError("AI agent not initialized");
  }

  try {
    // Clear thinking output for this turn
    session.thinkingOutput = "";

    // Send message to agent using .prompt() - it will stream thinking via onThinking callback
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
      // Handle both string and array content types
      if (typeof lastMessage.content === "string") {
        responseText = lastMessage.content;
      } else if (Array.isArray(lastMessage.content)) {
        // Extract text from content blocks
        responseText = lastMessage.content
          .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { type: string; text: string }) => c.text)
          .join("");
      }
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
          console.warn(
            `[planning] Parse attempt ${attempt + 1} failed for session ${session.id}, requesting reformat`
          );
          try {
            session.thinkingOutput = "";
            await session.agent.session.prompt(
              "Your previous response could not be parsed as JSON. " +
              'Please respond with ONLY a valid JSON object: either {"type":"question","data":{...}} ' +
              'or {"type":"complete","data":{...}}. No markdown, no explanation, just the JSON.'
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
                retryText = retryMessage.content
                  .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
                  .map((c: { type: string; text: string }) => c.text)
                  .join("");
              }
            }
            responseText = retryText;
          } catch (retryErr) {
            // Retry prompt itself failed — give up
            console.error(
              `[planning] Retry prompt failed for session ${session.id}:`,
              retryErr
            );
            break;
          }
        }
      }
    }

    if (!parsed) {
      // All attempts exhausted — emit actionable error
      const errorMsg = lastError?.message || "Failed to parse AI response";
      console.error(
        `[planning] All parse attempts exhausted for session ${session.id}:`,
        errorMsg
      );
      planningStreamManager.broadcast(session.id, {
        type: "error",
        data: `${errorMsg} You can try responding again or start a new planning session.`,
      });
      return;
    }

    if (parsed.type === "question") {
      session.currentQuestion = parsed.data;
      session.lastGeneratedThinking = session.thinkingOutput;
      session.updatedAt = new Date();
      persistSession(session, "awaiting_input");
      planningStreamManager.broadcast(session.id, {
        type: "question",
        data: parsed.data,
      });
    } else if (parsed.type === "complete") {
      session.summary = parsed.data;
      session.currentQuestion = undefined;
      session.updatedAt = new Date();
      persistSession(session, "complete");
      planningStreamManager.broadcast(session.id, {
        type: "summary",
        data: parsed.data,
      });
      planningStreamManager.broadcast(session.id, { type: "complete" });
    }
  } catch (err) {
    console.error(`[planning] Agent conversation error for session ${session.id}:`, err);
    persistSession(session, "error", undefined, err instanceof Error ? err.message : "AI processing failed");
    planningStreamManager.broadcast(session.id, {
      type: "error",
      data: err instanceof Error ? err.message : "AI processing failed",
    });
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
    console.error("[planning] No JSON candidate found in agent response:", text.slice(0, 500));
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
      console.error(
        "[planning] Failed to parse agent response (repair also failed):",
        candidate.slice(0, 500)
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

  console.error("[planning] Invalid response structure from AI:", JSON.stringify(parsed).slice(0, 500));
  throw new Error("AI returned an invalid response structure. Please try again.");
}

/**
 * Submit a response to the current question and get the next question or summary.
 * Supports both stubbed mode and AI agent mode.
 */
export async function submitResponse(
  sessionId: string,
  responses: Record<string, unknown>,
  rootDir?: string,
): Promise<PlanningResponse> {
  const session = getSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  if (!session.currentQuestion) {
    throw new InvalidSessionStateError("No active question in session");
  }

  // Record the response
  session.history.push({
    question: session.currentQuestion,
    response: responses,
    thinkingOutput: session.lastGeneratedThinking || "",
  });
  persistSession(session, "generating");

  if (!session.agent) {
    const replayHistory = session.history.slice(0, -1);
    await ensureSessionAgent(session, rootDir, replayHistory);
  }

  const message = formatResponseForAgent(session.currentQuestion, responses);
  await continueAgentConversation(session, message);

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
    const responseValue =
      response && typeof response === "object" && !Array.isArray(response)
        ? (response as Record<string, unknown>)[question.id]
        : response;

    return `**Q: ${question.question}**\nA: ${formatInterviewAnswer(question, responseValue)}`;
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
    console.error(`[planning] Failed to restore session ${sessionId} from SQLite:`, error);
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
 *
 * @param sessionId - The planning session ID
 * @returns Array of SubtaskItem with titles derived from keyDeliverables, or fallback
 */
export function generateSubtasksFromPlanning(sessionId: string): SubtaskItem[] {
  const session = sessions.get(sessionId);
  if (!session) return [];
  if (!session.summary) return [];

  const { summary } = session;
  const qaSection = formatInterviewQA(session.history);
  const descriptionWithContext = qaSection
    ? `${summary.description}\n\n${qaSection}`
    : summary.description;

  // If key deliverables exist, create one subtask per deliverable
  if (summary.keyDeliverables.length > 0) {
    return summary.keyDeliverables.map((deliverable, index) => {
      const id = `subtask-${index + 1}`;
      const dependsOn = index > 0 ? [`subtask-${index}`] : [] as string[];
      return {
        id,
        title: deliverable,
        description: descriptionWithContext,
        suggestedSize: index === 0 ? "S" as const : index === summary.keyDeliverables.length - 1 ? "S" as const : "M" as const,
        dependsOn,
      };
    });
  }

  // Fallback: 3 subtasks
  return [
    {
      id: "subtask-1",
      title: "Define implementation approach",
      description: descriptionWithContext,
      suggestedSize: "S" as const,
      dependsOn: [],
    },
    {
      id: "subtask-2",
      title: "Implement core changes",
      description: descriptionWithContext,
      suggestedSize: "M" as const,
      dependsOn: ["subtask-1"],
    },
    {
      id: "subtask-3",
      title: "Verify and polish",
      description: descriptionWithContext,
      suggestedSize: "S" as const,
      dependsOn: ["subtask-2"],
    },
  ];
}

/**
 * Cleanup a session (used after task creation).
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

  if (_aiSessionStore && _aiSessionDeletedListener) {
    _aiSessionStore.off("ai_session:deleted", _aiSessionDeletedListener);
  }
  _aiSessionDeletedListener = undefined;
  _aiSessionStore = undefined;
}

/**
 * Inject a mock createKbAgent function. Used for testing only.
 */
export function __setCreateKbAgent(mock: typeof createKbAgent): void {
  createKbAgent = mock;
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
