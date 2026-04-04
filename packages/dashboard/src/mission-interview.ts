/**
 * Mission Interview Session Management
 *
 * Manages AI-guided interview sessions for mission specification.
 * Uses an AI agent to conduct back-and-forth conversations that
 * produce structured mission plans (milestones, slices, features).
 *
 * Architecture mirrors planning.ts but targets the mission hierarchy.
 *
 * Features:
 * - AI agent integration with real-time streaming via SSE
 * - Rate limiting per IP
 * - Session expiration and cleanup
 * - SSE streaming via MissionInterviewStreamManager
 */

import type { PlanningQuestion } from "@fusion/core";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AiSessionStore, AiSessionRow } from "./ai-session-store.js";

// Dynamic import for @fusion/engine to avoid resolution issues in test environment
// eslint-disable-next-line @typescript-eslint/consistent-type-imports, @typescript-eslint/no-explicit-any
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

/** Session TTL in milliseconds (30 minutes) */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Cleanup interval in milliseconds (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Max interview sessions per IP per hour */
const MAX_SESSIONS_PER_IP_PER_HOUR = 5;

/** Rate limiting window in milliseconds (1 hour) */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Max number of retry attempts when AI returns unparseable output */
const MAX_PARSE_RETRIES = 1;

/** Mission interview system prompt */
export const MISSION_INTERVIEW_SYSTEM_PROMPT = `You are a mission planning assistant for a project management system.

Your job: help users transform high-level goals into structured mission plans with milestones, slices, and features — each with verification criteria.

## Mission Hierarchy
- Mission: The top-level objective (the user will provide this)
- Milestone: A major phase or deliverable within the mission (e.g., "Foundation & Infrastructure", "Core Feature Development", "Polish & Release"). Each milestone has verification criteria that define how to confirm the phase is complete.
- Slice: A focused work unit within a milestone that can be activated and worked on independently (e.g., "Auth system setup", "API endpoints", "UI components"). Each slice has verification criteria.
- Feature: A specific deliverable within a slice, detailed enough to become a task (e.g., "JWT token refresh endpoint", "Password reset email template"). Each feature has acceptance criteria.

## Conversation Flow
1. The user describes their mission goal
2. Ask clarifying questions to understand scope, constraints, technical context, user needs, and priorities
3. Push back on vague objectives — ask for specifics
4. Challenge unrealistic scope — suggest phasing
5. Once you have enough information (typically 4-8 questions), produce the structured plan
6. The plan should be thorough — break every milestone into slices, every slice into features

## Question Types to Use
- "text": Open-ended questions for detailed input
- "single_select": When user must choose one option (e.g., priority, approach)
- "multi_select": When multiple options can apply (e.g., features to include, platforms to support)
- "confirm": Yes/No questions for quick decisions

## Guidelines
- Start with big-picture scope questions, then narrow into specifics
- Ask about target users, key constraints, technical preferences, timeline
- Each milestone should represent a meaningful phase boundary or checkpoint
- Each slice should be independently shippable work
- Features should be specific and actionable
- ALWAYS include verification/acceptance criteria at every level:
  - Milestone: "verification" field — how to confirm this phase is complete (e.g., "All API endpoints return correct responses, integration tests pass")
  - Slice: "verification" field — how to confirm this work unit is done (e.g., "Auth flow works end-to-end from signup through login")
  - Feature: "acceptanceCriteria" field — how to verify this specific deliverable (e.g., "JWT tokens expire after 1 hour and refresh correctly")
- Suggest sensible defaults and push for specificity
- Aim for 2-4 milestones, 1-3 slices per milestone, 2-5 features per slice
- Keep the plan realistic and achievable

## Response Format
Always respond with valid JSON in one of these formats:

For questions:
{"type": "question", "data": {"id": "unique-id", "type": "text|single_select|multi_select|confirm", "question": "The question text", "description": "Helpful context", "options": [{"id": "opt1", "label": "Option 1", "description": "Details"}]}}

For completion (when you have enough information):
{"type": "complete", "data": {"missionTitle": "Refined mission title", "missionDescription": "Comprehensive mission description based on the conversation", "milestones": [{"title": "Milestone title", "description": "What this phase achieves", "verification": "How to confirm this milestone is complete", "slices": [{"title": "Slice title", "description": "What this work unit covers", "verification": "How to confirm this slice is done", "features": [{"title": "Feature title", "description": "What to build", "acceptanceCriteria": "How to verify this feature works"}]}]}]}}`;

// ── Types ───────────────────────────────────────────────────────────────────

/** A feature within a slice in the generated plan */
export interface MissionPlanFeature {
  title: string;
  description?: string;
  acceptanceCriteria?: string;
}

/** A slice within a milestone in the generated plan */
export interface MissionPlanSlice {
  title: string;
  description?: string;
  verification?: string;
  features: MissionPlanFeature[];
}

/** A milestone in the generated plan */
export interface MissionPlanMilestone {
  title: string;
  description?: string;
  verification?: string;
  slices: MissionPlanSlice[];
}

/** The complete mission plan summary produced by the interview */
export interface MissionPlanSummary {
  missionTitle?: string;
  missionDescription?: string;
  milestones: MissionPlanMilestone[];
}

/** Response from interview: either a question or a completed plan */
export type MissionInterviewResponse =
  | { type: "question"; data: PlanningQuestion }
  | { type: "complete"; data: MissionPlanSummary };

/** SSE event types for mission interview streaming */
export type MissionInterviewStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "question"; data: PlanningQuestion }
  | { type: "summary"; data: MissionPlanSummary }
  | { type: "error"; data: string }
  | { type: "complete" };

/** Callback function for streaming events */
export type MissionInterviewStreamCallback = (event: MissionInterviewStreamEvent) => void;

/** In-memory interview session */
interface MissionInterviewSession {
  id: string;
  ip: string;
  missionId: string;
  missionTitle: string;
  history: Array<{ question: PlanningQuestion; response: unknown }>;
  currentQuestion?: PlanningQuestion;
  summary?: MissionPlanSummary;
  agent?: AgentResult;
  thinkingOutput: string;
  createdAt: Date;
  updatedAt: Date;
}

interface RateLimitEntry {
  count: number;
  firstRequestAt: Date;
}

// ── In-Memory Storage ───────────────────────────────────────────────────────

const sessions = new Map<string, MissionInterviewSession>();
const rateLimits = new Map<string, RateLimitEntry>();

// ── AI Session Persistence ────────────────────────────────────────────────

let _aiSessionStore: AiSessionStore | undefined;

export function setAiSessionStore(store: AiSessionStore): void {
  _aiSessionStore = store;
}

function persistMissionSession(session: MissionInterviewSession, status: "generating" | "awaiting_input" | "complete" | "error", error?: string): void {
  if (!_aiSessionStore) return;
  const row: AiSessionRow = {
    id: session.id,
    type: "mission_interview",
    status,
    title: session.missionTitle.slice(0, 120),
    inputPayload: JSON.stringify({ missionTitle: session.missionTitle }),
    conversationHistory: JSON.stringify(session.history),
    currentQuestion: session.currentQuestion ? JSON.stringify(session.currentQuestion) : null,
    result: session.summary ? JSON.stringify(session.summary) : null,
    thinkingOutput: session.thinkingOutput,
    error: error ?? null,
    projectId: null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: new Date().toISOString(),
  };
  _aiSessionStore.upsert(row);
}

function persistMissionThinking(sessionId: string, thinkingOutput: string): void {
  if (!_aiSessionStore) return;
  _aiSessionStore.updateThinking(sessionId, thinkingOutput);
}

function unpersistMissionSession(sessionId: string): void {
  if (!_aiSessionStore) return;
  _aiSessionStore.delete(sessionId);
}

// ── Cleanup Interval ────────────────────────────────────────────────────────

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.updatedAt.getTime() > SESSION_TTL_MS) {
      if (session.agent) {
        try { session.agent.session.dispose?.(); } catch { /* ignore */ }
      }
      missionInterviewStreamManager.cleanupSession(id);
      sessions.delete(id);
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

export class MissionInterviewStreamManager extends EventEmitter {
  private sessions = new Map<string, Set<MissionInterviewStreamCallback>>();

  subscribe(sessionId: string, callback: MissionInterviewStreamCallback): () => void {
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

  broadcast(sessionId: string, event: MissionInterviewStreamEvent): void {
    const callbacks = this.sessions.get(sessionId);
    if (!callbacks) return;
    for (const callback of callbacks) {
      try {
        callback(event);
      } catch (err) {
        console.error(`[mission-interview] Error broadcasting to client for session ${sessionId}:`, err);
      }
    }
  }

  hasSubscribers(sessionId: string): boolean {
    const callbacks = this.sessions.get(sessionId);
    return callbacks !== undefined && callbacks.size > 0;
  }

  cleanupSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export const missionInterviewStreamManager = new MissionInterviewStreamManager();

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

// ── JSON Parsing Utilities ─────────────────────────────────────────────────

/**
 * Extract the best JSON candidate from AI response text.
 * Handles markdown-wrapped JSON, embedded prose, and multiple objects.
 */
function extractJsonCandidate(text: string): string | null {
  if (!text || !text.trim()) return null;

  // 1. Try markdown code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    const candidate = codeBlockMatch[1].trim();
    if (candidate.startsWith("{")) return candidate;
  }

  // 2. Find all top-level brace-delimited objects using balanced brace counting
  const candidates: Array<{ text: string }> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        if (ch === "}") depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1).trim();
          try {
            JSON.parse(candidate);
            candidates.push({ text: candidate });
          } catch { /* not valid JSON */ }
          break;
        }
      }
    }
  }

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
 * Attempt to repair common JSON issues.
 */
function repairJson(text: string): string {
  let repaired = text;
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");

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

  if (inString) repaired += '"';

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

  repaired += "]".repeat(Math.max(0, openBrackets));
  repaired += "}".repeat(Math.max(0, openBraces));

  return repaired;
}

/**
 * Parse AI agent response into a MissionInterviewResponse.
 * Handles markdown wrapping, embedded prose, truncated JSON.
 */
export function parseMissionAgentResponse(text: string): MissionInterviewResponse {
  const candidate = extractJsonCandidate(text);

  if (!candidate) {
    console.error("[mission-interview] No JSON candidate found in agent response:", text.slice(0, 500));
    throw new Error("AI returned no valid JSON. Please try again.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    try {
      const repaired = repairJson(candidate);
      parsed = JSON.parse(repaired);
    } catch (repairErr) {
      console.error("[mission-interview] Failed to parse agent response:", candidate.slice(0, 500));
      throw new Error(
        `Failed to parse AI response: ${repairErr instanceof Error ? repairErr.message : "Unknown error"}. Please try again.`
      );
    }
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    "data" in parsed
  ) {
    const typed = parsed as { type: string; data: unknown };
    if (typed.type === "question" && typed.data !== null && typed.data !== undefined) {
      return parsed as MissionInterviewResponse;
    }
    if (typed.type === "complete" && typed.data !== null && typeof typed.data === "object") {
      const data = typed.data as Record<string, unknown>;
      if (Array.isArray(data.milestones)) {
        return parsed as MissionInterviewResponse;
      }
    }
  }

  console.error("[mission-interview] Invalid response structure:", JSON.stringify(parsed).slice(0, 500));
  throw new Error("AI returned an invalid response structure. Please try again.");
}

// ── Response Formatting ────────────────────────────────────────────────────

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

// ── AI Agent Integration ───────────────────────────────────────────────────

/**
 * Initialize the AI agent for a session and start the first turn.
 */
async function initializeAgent(session: MissionInterviewSession, rootDir: string): Promise<void> {
  try {
    await engineReady;

    const agentResult = await createKbAgent({
      cwd: rootDir,
      systemPrompt: MISSION_INTERVIEW_SYSTEM_PROMPT,
      tools: "readonly",
      onThinking: (delta: string) => {
        session.thinkingOutput += delta;
        persistMissionThinking(session.id, session.thinkingOutput);
        missionInterviewStreamManager.broadcast(session.id, {
          type: "thinking",
          data: delta,
        });
      },
      onText: (delta: string) => {
        session.thinkingOutput += delta;
      },
    });

    session.agent = agentResult;
    session.updatedAt = new Date();

    // Send initial message to get first question
    await continueAgentConversation(
      session,
      `I want to plan a mission: "${session.missionTitle}". Interview me to understand what I need, then produce a structured plan.`
    );
  } catch (err) {
    console.error(`[mission-interview] Agent initialization error for session ${session.id}:`, err);
    missionInterviewStreamManager.broadcast(session.id, {
      type: "error",
      data: err instanceof Error ? err.message : "Failed to initialize AI agent",
    });
  }
}

/**
 * Continue the AI conversation with a user message.
 * Includes bounded recovery: one retry on parse failure.
 */
async function continueAgentConversation(session: MissionInterviewSession, message: string): Promise<void> {
  if (!session.agent) {
    throw new InvalidSessionStateError("AI agent not initialized");
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

    // Parse with retry
    let parsed: MissionInterviewResponse | undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
      try {
        parsed = parseMissionAgentResponse(responseText);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < MAX_PARSE_RETRIES) {
          console.warn(
            `[mission-interview] Parse attempt ${attempt + 1} failed for session ${session.id}, requesting reformat`
          );
          try {
            session.thinkingOutput = "";
            await session.agent.session.prompt(
              "Your previous response could not be parsed as JSON. " +
              'Please respond with ONLY a valid JSON object: either {"type":"question","data":{...}} ' +
              'or {"type":"complete","data":{"missionTitle":"...","missionDescription":"...","milestones":[...]}}. ' +
              "No markdown, no explanation, just the JSON."
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
            console.error(`[mission-interview] Retry prompt failed for session ${session.id}:`, retryErr);
            break;
          }
        }
      }
    }

    if (!parsed) {
      const errorMsg = lastError?.message || "Failed to parse AI response";
      console.error(`[mission-interview] All parse attempts exhausted for session ${session.id}:`, errorMsg);
      missionInterviewStreamManager.broadcast(session.id, {
        type: "error",
        data: `${errorMsg} You can try responding again or start a new session.`,
      });
      return;
    }

    if (parsed.type === "question") {
      session.currentQuestion = parsed.data;
      session.updatedAt = new Date();
      persistMissionSession(session, "awaiting_input");
      missionInterviewStreamManager.broadcast(session.id, {
        type: "question",
        data: parsed.data,
      });
    } else if (parsed.type === "complete") {
      session.summary = parsed.data;
      session.currentQuestion = undefined;
      session.updatedAt = new Date();
      persistMissionSession(session, "complete");
      missionInterviewStreamManager.broadcast(session.id, {
        type: "summary",
        data: parsed.data,
      });
      missionInterviewStreamManager.broadcast(session.id, { type: "complete" });
    }
  } catch (err) {
    console.error(`[mission-interview] Agent conversation error for session ${session.id}:`, err);
    persistMissionSession(session, "error", err instanceof Error ? err.message : "AI processing failed");
    missionInterviewStreamManager.broadcast(session.id, {
      type: "error",
      data: err instanceof Error ? err.message : "AI processing failed",
    });
  }
}

// ── Session Management ──────────────────────────────────────────────────────

/**
 * Create a new mission interview session with AI agent streaming.
 * Returns sessionId immediately; client connects to SSE to receive events.
 */
export async function createMissionInterviewSession(
  ip: string,
  missionTitle: string,
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

  const session: MissionInterviewSession = {
    id: sessionId,
    ip,
    missionId: "",
    missionTitle,
    history: [],
    thinkingOutput: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  sessions.set(sessionId, session);
  persistMissionSession(session, "generating");

  // Initialize AI agent in background
  initializeAgent(session, rootDir).catch((err) => {
    console.error(`[mission-interview] Failed to initialize agent for session ${sessionId}:`, err);
    persistMissionSession(session, "error", err.message || "Failed to initialize AI agent");
    missionInterviewStreamManager.broadcast(sessionId, {
      type: "error",
      data: err.message || "Failed to initialize AI agent",
    });
  });

  return sessionId;
}

/**
 * Submit a response to the current question.
 * Supports AI agent mode with streaming.
 */
export async function submitMissionInterviewResponse(
  sessionId: string,
  responses: Record<string, unknown>
): Promise<MissionInterviewResponse> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Mission interview session ${sessionId} not found or expired`);
  }

  if (!session.currentQuestion) {
    throw new InvalidSessionStateError("No active question in session");
  }

  // Record the response
  session.history.push({
    question: session.currentQuestion,
    response: responses,
  });
  persistMissionSession(session, "generating");

  // If AI agent is active, use it for next question
  if (session.agent) {
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
        question: "Could you tell me more about what you want to build?",
        description: "The AI is processing your response. Please provide more details.",
      },
    };
  }

  // No agent — should not happen in normal flow
  throw new InvalidSessionStateError("AI agent not available for this session");
}

export async function cancelMissionInterviewSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Mission interview session ${sessionId} not found or expired`);
  }

  if (session.agent) {
    try { session.agent.session.dispose?.(); } catch { /* ignore */ }
    session.agent = undefined;
  }

  missionInterviewStreamManager.cleanupSession(sessionId);
  sessions.delete(sessionId);
  unpersistMissionSession(sessionId);
}

export function getMissionInterviewSession(sessionId: string): MissionInterviewSession | undefined {
  return sessions.get(sessionId);
}

export function getMissionInterviewSummary(sessionId: string): MissionPlanSummary | undefined {
  return sessions.get(sessionId)?.summary;
}

export function cleanupMissionInterviewSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session?.agent) {
    try { session.agent.session.dispose?.(); } catch { /* ignore */ }
  }
  missionInterviewStreamManager.cleanupSession(sessionId);
  sessions.delete(sessionId);
  unpersistMissionSession(sessionId);
}

/**
 * Reset all mission interview state. Used for testing only.
 */
export function __resetMissionInterviewState(): void {
  for (const [, session] of sessions) {
    if (session.agent) {
      try { session.agent.session.dispose?.(); } catch { /* ignore */ }
    }
  }
  sessions.clear();
  rateLimits.clear();
  missionInterviewStreamManager.removeAllListeners();
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
