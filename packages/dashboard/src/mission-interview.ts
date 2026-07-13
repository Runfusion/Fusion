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
 * - Prompt override support for project-level customization
 */

import type { PlanningQuestion, PromptOverrideMap, TaskStore, ThinkingLevel } from "@fusion/core";
import { resolvePrompt, THINKING_LEVELS } from "@fusion/core";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AiSessionStore, AiSessionRow, AiSessionStatus, AiSessionSummary } from "./ai-session-store.js";
import { SessionEventBuffer, type SessionBufferedEvent } from "./sse-buffer.js";
import { registerBeforeExitCleanup } from "./process-lifecycle.js";
import {
  createSessionDiagnostics,
  resetDiagnosticsSink,
  nonfatal,
} from "./ai-session-diagnostics.js";
import { createAbortError, GenerationGuard, isAbortError } from "./ai-session-timeout.js";

import { buildSessionSkillContextSync, createFnAgent as engineCreateFnAgent, resolveMcpServersForStore } from "@fusion/engine";
import { createPlanningBoardTools } from "./planning-board-tools.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentResult = any;
type SkillPluginRunner = Parameters<typeof buildSessionSkillContextSync>[3];
const MISSION_INTERVIEW_BUILTIN_WEB_TOOLS = ["WebSearch", "WebFetch"] as const;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createFnAgent: any = engineCreateFnAgent;

/**
 * Shared diagnostics helper for the mission-interview module.
 * Uses the shared ai-session-diagnostics helper for consistent scoped logging.
 * @see ai-session-diagnostics.ts for the shared contract
 */
const diagnostics = createSessionDiagnostics("mission-interview");

/**
 * Get the current diagnostics logger (for backward compatibility).
 * @internal - exposed for test hook
 */
export function __getMissionInterviewDiagnostics() {
  return diagnostics;
}

/**
 * Inject a diagnostics sink (test-only).
 * Delegates to the shared ai-session-diagnostics sink.
 * When a sink is injected, all mission-interview module diagnostics route through it.
 * This allows tests to assert on diagnostics without global console spies.
 * @internal - exposed for test hook
 */
export function __setMissionInterviewDiagnostics(_logger: unknown): void {
  // For backward compatibility, we keep this function but it now delegates
  // to the shared helper's sink mechanism. The actual sink injection
  // should use setDiagnosticsSink() from ai-session-diagnostics.
  if (_logger === null) {
    resetDiagnosticsSink();
  }
}

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
 * Per-turn generation timeout. Mission interview turns produce larger plans
 * than planning, so this is more generous than planning's 120 s. Bounds the
 * worst case for a silently-stalled model stream or hung tool call.
 */
export const GENERATION_TIMEOUT_MS = 180_000;

const generationGuard = new GenerationGuard();

const MISSION_INTERVIEW_DRAFT_STATUSES = ["generating", "awaiting_input", "error", "complete"] as const;

function isMissionInterviewDraftStatus(
  status: AiSessionStatus,
): status is Extract<AiSessionStatus, (typeof MISSION_INTERVIEW_DRAFT_STATUSES)[number]> {
  return (MISSION_INTERVIEW_DRAFT_STATUSES as readonly string[]).includes(status);
}

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
PREFER structured question types over free-text. This makes the interview faster and more focused.

- "single_select" (DEFAULT): Use for most questions. Provide 3–6 options covering the common choices.
  ALWAYS include an "Other (please describe)" or "Custom" option as the LAST option so users can provide free-form input.
  Examples: tech stack, deployment target, priority level, integration approach, architecture style.
- "multi_select": Use when multiple options can apply simultaneously (e.g., features to include, platforms to support, security requirements).
  Provide 4–6 options. Include an "Other (please describe)" option at the end.
- "confirm": Use for simple yes/no or go/no-go decisions (e.g., "Should we include offline support?", "Is backwards compatibility required?").
- "text": Use ONLY when genuinely needed — asking for a project name, URL, specific API endpoint, or other unique free-form values that cannot be reasonably optioned.

## Question Design Guidelines
- Provide specific, well-crafted option labels and descriptions so users can quickly select without thinking
- Options should be mutually exclusive and collectively exhaustive for single_select
- Use domain-appropriate jargon in option labels (developers understand "GraphQL", "REST", "gRPC")
- Include 3–6 options per question — never fewer than 3, rarely more than 6
- The last option should always be something like { "id": "other", "label": "Other (please describe)" } for single_select, or similar for multi_select
- Start with big-picture scope questions, then narrow into specifics
- Ask about target users, key constraints, technical preferences, timeline
- Each milestone should represent a meaningful phase boundary or checkpoint
- Each slice should be independently shippable work
- Features should be specific and actionable
- ALWAYS include verification/acceptance criteria at every level:
  - Milestone: "verification" field — how to confirm this phase is complete (e.g., "All API endpoints return correct responses, integration tests pass")
  - Milestone: optional "acceptanceCriteria" field for explicit milestone-level completion bars (if omitted, acceptance can be auto-derived from child feature criteria/descriptions)
  - Slice: "verification" field — how to confirm this work unit is done (e.g., "Auth flow works end-to-end from signup through login")
  - Feature: "acceptanceCriteria" field — how to verify this specific deliverable (e.g., "JWT tokens expire after 1 hour and refresh correctly")
- Suggest sensible defaults and push for specificity
- Aim for 2-4 milestones, 1-3 slices per milestone, 2-5 features per slice
- Keep the plan realistic and achievable

## Board tools
- fn_task_list — list active tasks
- fn_task_show — read a task's full details and PROMPT.md
Use these to avoid duplicating an existing in-flight plan and to anchor your questions against current backlog context.

## Response Format
Always respond with valid JSON in one of these formats:

For single_select question (DEFAULT — use this for most questions):
{"type": "question", "data": {"id": "q-tech-stack", "type": "single_select", "question": "What is the primary technology stack?", "description": "Select the main framework or stack for the project", "options": [{"id": "react-ts", "label": "React + TypeScript", "description": "Component-based UI with type safety"}, {"id": "nextjs", "label": "Next.js", "description": "Full-stack React framework with SSR"}, {"id": "vue", "label": "Vue.js", "description": "Progressive JavaScript framework"}, {"id": "backend-only", "label": "Backend / API only", "description": "No frontend, pure server-side project"}, {"id": "other", "label": "Other (please describe)", "description": "Specify your custom stack"}]}}

For multi_select question:
{"type": "question", "data": {"id": "q-platforms", "type": "multi_select", "question": "Which platforms should be supported?", "description": "Select all that apply", "options": [{"id": "web", "label": "Web browser", "description": "Desktop and mobile web"}, {"id": "ios", "label": "iOS", "description": "iPhone and iPad"}, {"id": "android", "label": "Android", "description": "Phones and tablets"}, {"id": "desktop", "label": "Desktop app", "description": "Electron or native desktop"}, {"id": "api", "label": "API / headless", "description": "Programmatic access only"}, {"id": "other", "label": "Other (please describe)", "description": "Specify additional platforms"}]}}

For confirm question:
{"type": "question", "data": {"id": "q-auth", "type": "confirm", "question": "Should the system require user authentication?", "description": "Login, sessions, and access control"}}

For text question (use ONLY for names, URLs, or truly unique free-form input):
{"type": "question", "data": {"id": "q-project-name", "type": "text", "question": "What is the project or product name?", "description": "Used in documentation and configuration"}}

For completion (when you have enough information):
{"type": "complete", "data": {"missionTitle": "Refined mission title", "missionDescription": "Comprehensive mission description based on the conversation", "milestones": [{"title": "Milestone title", "description": "What this phase achieves", "verification": "How to confirm this milestone is complete", "acceptanceCriteria": "Optional explicit milestone criteria (omit to auto-derive from features)", "slices": [{"title": "Slice title", "description": "What this work unit covers", "verification": "How to confirm this slice is done", "features": [{"title": "Feature title", "description": "What to build", "acceptanceCriteria": "How to verify this feature works"}]}]}]}}`;

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
  acceptanceCriteria?: string;
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

export interface MissionInterviewDraftSummary {
  id: string;
  title: string;
  status: Extract<AiSessionStatus, (typeof MISSION_INTERVIEW_DRAFT_STATUSES)[number]>;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  hasConversation: boolean;
}

/** SSE event types for mission interview streaming */
export type MissionInterviewStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "text"; data: string }
  | { type: "question"; data: PlanningQuestion }
  | { type: "summary"; data: MissionPlanSummary }
  | { type: "error"; data: string }
  | { type: "complete" };

/** Callback function for streaming events */
export type MissionInterviewStreamCallback = (event: MissionInterviewStreamEvent, eventId?: number) => void;

interface MissionInterviewHistoryEntry {
  question: PlanningQuestion;
  response: unknown;
  thinkingOutput?: string;
}

/** In-memory interview session */
interface MissionInterviewSession {
  id: string;
  ip: string;
  projectId: string | null;
  missionId: string;
  missionTitle: string;
  history: MissionInterviewHistoryEntry[];
  currentQuestion?: PlanningQuestion;
  summary?: MissionPlanSummary;
  /** Last terminal error for retry UX */
  error?: string;
  agent?: AgentResult;
  thinkingOutput: string;
  /** Thinking output generated while producing currentQuestion */
  lastGeneratedThinking: string;
  /** Model override for this interview session */
  modelProvider?: string;
  modelId?: string;
  /**
   * FNXC:MissionInterview 2026-07-12-00:00:
   * Mission interview sessions carry a validated per-session reasoning effort in inputPayload so reopened interviews can rebuild agents with the same thinking level without a SQLite schema change.
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * Captured at session creation so rehydrated sessions can rebuild their
   * agent without the caller threading context through every API.
   */
  store?: TaskStore;
  rootDir?: string;
  /** Plugin runner captured while the server is alive so rebuilt mission interview agents keep plugin-contributed skills. */
  pluginRunner?: SkillPluginRunner;
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
    cleanupInMemoryMissionSession(sessionId);
  };
  _aiSessionStore.on("ai_session:deleted", _aiSessionDeletedListener);
}

function cleanupInMemoryMissionSession(sessionId: string): boolean {
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

  missionInterviewStreamManager.cleanupSession(sessionId);
  sessions.delete(sessionId);
  return true;
}

function persistMissionSession(session: MissionInterviewSession, status: "generating" | "awaiting_input" | "complete" | "error", error?: string): void {
  if (!_aiSessionStore) return;
  const row: AiSessionRow = {
    id: session.id,
    type: "mission_interview",
    status,
    title: session.missionTitle.slice(0, 120),
    inputPayload: JSON.stringify({
      ip: session.ip,
      projectId: session.projectId,
      missionTitle: session.missionTitle,
      missionId: session.missionId,
      modelProvider: session.modelProvider,
      modelId: session.modelId,
      thinkingLevel: session.thinkingLevel,
    }),
    conversationHistory: JSON.stringify(session.history),
    currentQuestion: session.currentQuestion ? JSON.stringify(session.currentQuestion) : null,
    result: session.summary ? JSON.stringify(session.summary) : null,
    thinkingOutput: session.thinkingOutput,
    error: error ?? null,
    projectId: session.projectId,
    createdAt: session.createdAt.toISOString(),
    updatedAt: new Date().toISOString(),
    lockedByTab: null,
    lockedAt: null,
  };
  _aiSessionStore.upsert(row).catch(() => { /* best-effort persistence */ });
}

function persistMissionThinking(sessionId: string, thinkingOutput: string): void {
  if (!_aiSessionStore) return;
  _aiSessionStore.updateThinking(sessionId, thinkingOutput);
}

function unpersistMissionSession(sessionId: string): void {
  if (!_aiSessionStore) return;
  void _aiSessionStore.delete(sessionId);
}

function buildMissionInterviewSessionFromRow(row: AiSessionRow): MissionInterviewSession {
  const payload = safeParseJson<{ ip?: string; projectId?: string | null; missionId?: string; missionTitle?: string; modelProvider?: string; modelId?: string; thinkingLevel?: string }>(
    row.inputPayload,
    {},
    { throwOnError: true, fieldName: "inputPayload" },
  );
  const thinkingLevel = THINKING_LEVELS.includes(payload.thinkingLevel as ThinkingLevel)
    ? (payload.thinkingLevel as ThinkingLevel)
    : undefined;

  const createdAt = new Date(row.createdAt);
  const updatedAt = new Date(row.updatedAt);

  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())) {
    throw new Error("Invalid session timestamps");
  }

  return {
    id: row.id,
    ip: payload.ip ?? "",
    projectId: row.projectId ?? payload.projectId ?? null,
    missionId: payload.missionId ?? "",
    missionTitle: payload.missionTitle ?? row.title,
    history: safeParseJson<MissionInterviewHistoryEntry[]>(
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
      ? (safeParseJson<MissionPlanSummary | null>(row.result, null, {
          throwOnError: true,
          fieldName: "result",
        }) ?? undefined)
      : undefined,
    thinkingOutput: row.thinkingOutput,
    lastGeneratedThinking: row.thinkingOutput || "",
    error: row.error ?? undefined,
    modelProvider: payload.modelProvider,
    modelId: payload.modelId,
    thinkingLevel,
    createdAt,
    updatedAt,
    agent: undefined,
  };
}

export async function rehydrateFromStore(store: AiSessionStore): Promise<number> {
  let rows: AiSessionRow[] = [];

  try {
    rows = (await store.listRecoverable()).filter((row) => row.type === "mission_interview");
  } catch (error) {
    diagnostics.errorFromException("Failed to list recoverable sessions", error, { operation: "list-recoverable" });
    return 0;
  }

  let rehydrated = 0;
  for (const row of rows) {
    try {
      const session = buildMissionInterviewSessionFromRow(row);
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
      cleanupInMemoryMissionSession(id);
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

export class MissionInterviewStreamManager extends EventEmitter {
  private readonly sessions = new Map<string, Set<MissionInterviewStreamCallback>>();
  private readonly buffers = new Map<string, SessionEventBuffer>();

  constructor(private readonly bufferSize = 100) {
    super();
  }

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

  private getBuffer(sessionId: string): SessionEventBuffer {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = new SessionEventBuffer(this.bufferSize);
      this.buffers.set(sessionId, buffer);
    }
    return buffer;
  }

  broadcast(sessionId: string, event: MissionInterviewStreamEvent): number {
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
export function extractJsonCandidate(text: string): string | null {
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
export function repairJson(text: string): string {
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
    diagnostics.error("No JSON candidate found in agent response", { inputSnippet: text.slice(0, 500), operation: "parse-json" });
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
      diagnostics.error("Failed to parse agent response (repair also failed)", { inputSnippet: candidate.slice(0, 500), operation: "parse-json-repair" });
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

  diagnostics.error("Invalid response structure from AI", { parsedSnippet: JSON.stringify(parsed).slice(0, 500), operation: "parse-validate" });
  throw new Error("AI returned an invalid response structure. Please try again.");
}

// ── Response Formatting ────────────────────────────────────────────────────

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
      GitHub #1794 requires mission Other-only single-select answers to reach the agent as the user's own answer rather than an undefined fallback or unwanted provided option.
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
        Mission multi-select Other answers are additive context; append the free-text answer to selected labels and keep Other-only payloads explicit for the agent.
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

function disposeMissionAgentForRetry(session: MissionInterviewSession): void {
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
prior entry before the new op runs). Retry/rewind flows call disposeMissionAgentForRetry(session)
themselves and then assign a brand-new session.agent BEFORE the retry's own generationGuard.run()
call displaces the stale (already-forgotten) entry from session creation/history-replay. If the
stale entry's onAbort teardown reads session.agent dynamically at teardown time (as
disposeMissionAgentForRetry does), it disposes the FRESH agent the retry just installed — not the
stale one — and the retry's own operation then crashes on `session.agent!` being undefined.
Capture the exact agent instance a generation started with and only tear down / clear that
specific instance, so a later displacement can never dispose an agent installed by a newer call.
*/
function disposeMissionAgentGeneration(session: MissionInterviewSession, agent: AgentResult | undefined): void {
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

/**
 * Initialize the AI agent for a session and start the first turn.
 */
async function initializeAgent(
  session: MissionInterviewSession,
  rootDir: string,
  store: TaskStore,
  promptOverrides?: PromptOverrideMap,
  pluginRunner?: SkillPluginRunner,
): Promise<void> {
  try {
    session.agent = await createMissionInterviewAgent(session, rootDir, store, promptOverrides, pluginRunner);
    session.updatedAt = new Date();

    // Send initial message to get first question
    await continueAgentConversation(
      session,
      `I want to plan a mission: "${session.missionTitle}". Interview me to understand what I need, then produce a structured plan.`,
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Failed to initialize AI agent";
    diagnostics.errorFromException("Agent initialization error for session", err, { sessionId: session.id, operation: "initialize-agent" });
    session.error = errorMessage;
    session.updatedAt = new Date();
    persistMissionSession(session, "error", errorMessage);
    missionInterviewStreamManager.broadcast(session.id, {
      type: "error",
      data: errorMessage,
    });
  }
}

export async function createMissionInterviewAgent(
  session: MissionInterviewSession,
  rootDir: string,
  store: TaskStore,
  promptOverrides?: PromptOverrideMap,
  pluginRunner?: SkillPluginRunner,
): Promise<AgentResult> {
  await ensureEngineReady();

  const effectivePrompt = resolvePrompt("mission-interview-system", promptOverrides);
  const skillContext = buildSessionSkillContextSync(null, "executor", rootDir, pluginRunner);

  /*
  FNXC:MissionInterviewSkills 2026-06-17-19:33:
  Mission interview sessions are agent-acting planning lanes, so they request executor role fallback skills plus enabled plugin skills to keep ce-debug-style skills available outside task execution.

  FNXC:McpConfig 2026-06-26-00:00:
  Mission interviews have a TaskStore for planning-board tools and are agent-work sessions, so forward the store-resolved MCP set while keeping resolved secret values out of logs and persisted session state.

  FNXC:McpConfig 2026-06-29-00:00:
  Mission interviews are read-only planning lanes that intentionally expose configured MCP context tools; the engine opt-in preserves the read-only default for unrelated validator sessions.
  */
  const mcpServers = (await resolveMcpServersForStore(store)).servers;
  return createFnAgent({
    cwd: rootDir,
    systemPrompt: effectivePrompt,
    tools: "readonly",
    mcpServers,
    allowMcpToolsInReadonly: true,
    ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    builtinToolsAllowlist: [...MISSION_INTERVIEW_BUILTIN_WEB_TOOLS],
    customTools: [...createPlanningBoardTools(store)],
    ...(session.modelProvider && session.modelId
      ? {
          defaultProvider: session.modelProvider,
          defaultModelId: session.modelId,
        }
      : {}),
    ...(session.thinkingLevel ? { defaultThinkingLevel: session.thinkingLevel } : {}),
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
      missionInterviewStreamManager.broadcast(session.id, {
        type: "text",
        data: delta,
      });
    },
  });
}

function formatMissionHistoryAnswer(question: PlanningQuestion, responseValue: unknown, other: string): string {
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

export function formatMissionInterviewHistory(
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
        `A: ${formatMissionHistoryAnswer(question, responseValue, other)}`,
      ];

      if (comment.length > 0) {
        lines.push(`Comment: ${comment}`);
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

async function ensureMissionInterviewAgent(
  session: MissionInterviewSession,
  rootDir: string | undefined,
  store: TaskStore | undefined,
  historyForReplay: Array<{ question: PlanningQuestion; response: unknown }>,
  promptOverrides?: PromptOverrideMap,
): Promise<void> {
  if (session.agent) {
    return;
  }

  const effectiveRootDir = rootDir ?? session.rootDir;
  const effectiveStore = store ?? session.store;

  if (!effectiveRootDir) {
    throw new InvalidSessionStateError(
      "AI agent not available for this session and cannot be resumed without project context",
    );
  }
  if (!effectiveStore) {
    throw new InvalidSessionStateError(
      "AI agent not available for this session and cannot be resumed without task store context",
    );
  }

  session.agent = await createMissionInterviewAgent(session, effectiveRootDir, effectiveStore, promptOverrides, session.pluginRunner);

  if (historyForReplay.length === 0) {
    return;
  }

  const historySummary = formatMissionInterviewHistory(historyForReplay);
  if (!historySummary) {
    return;
  }

  const replayAgent = session.agent;
  await generationGuard.run(
    session.id,
    GENERATION_TIMEOUT_MS,
    {
      onTimeout: () => setMissionSessionError(
        session,
        "AI generation timed out while restoring context. You can retry or start a new session.",
      ),
      onUserStop: () => setMissionSessionError(
        session,
        "Generation stopped by user. You can retry or start a new session.",
      ),
      onAbort: () => disposeMissionAgentGeneration(session, replayAgent),
    },
    async (abortSignal) => {
      /*
      FNXC:AiSessionCancellation 2026-07-13-00:00:
      FN-7951 requires every mission-interview prompt, including history replay, to receive the generation AbortSignal. Promise.race only stops the caller from awaiting; signal forwarding plus guard-level session teardown is the cancellation contract.
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

function setMissionSessionError(session: MissionInterviewSession, message: string): void {
  session.error = message;
  session.updatedAt = new Date();
  persistMissionSession(session, "error", message);
  missionInterviewStreamManager.broadcast(session.id, {
    type: "error",
    data: message,
  });
}

/**
 * Manually abort an in-flight mission interview generation. Returns true if
 * a generation was active and got aborted.
 */
export function stopMissionInterviewGeneration(sessionId: string): boolean {
  return generationGuard.stop(sessionId);
}

/**
 * Continue the AI conversation with a user message.
 * Includes bounded recovery: one retry on parse failure.
 *
 * The entire body — including the parse-retry inner `prompt()` calls — runs
 * inside `generationGuard.run`, so a stalled stream or hung tool call on
 * either the first or retry attempt is bounded by `GENERATION_TIMEOUT_MS`.
 */
async function continueAgentConversation(session: MissionInterviewSession, message: string): Promise<void> {
  if (!session.agent) {
    throw new InvalidSessionStateError("AI agent not initialized");
  }

  const generationAgent = session.agent;
  try {
    await generationGuard.run(
      session.id,
      GENERATION_TIMEOUT_MS,
      {
        onTimeout: () => setMissionSessionError(
          session,
          "AI generation timed out. You can retry or start a new session.",
        ),
        onUserStop: () => setMissionSessionError(
          session,
          "Generation stopped by user. You can retry or start a new session.",
        ),
        onAbort: () => disposeMissionAgentGeneration(session, generationAgent),
      },
      async (abortSignal) => {
        const agent = session.agent!;
        session.thinkingOutput = "";

        /*
        FNXC:AiSessionCancellation 2026-07-13-00:00:
        Mission interview turns and parse-retry prompts must pass the active AbortSignal to prompt() and short-circuit after abort. The GenerationGuard also tears down the agent session because provider SDKs may ignore the signal.
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
                  'or {"type":"complete","data":{"missionTitle":"...","missionDescription":"...","milestones":[...]}}. ' +
                  "No markdown, no explanation, just the JSON.",
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
          setMissionSessionError(session, errorMsg);
          return;
        }

        if (parsed.type === "question") {
          session.currentQuestion = parsed.data;
          session.error = undefined;
          session.lastGeneratedThinking = session.thinkingOutput;
          session.updatedAt = new Date();
          persistMissionSession(session, "awaiting_input");
          missionInterviewStreamManager.broadcast(session.id, {
            type: "question",
            data: parsed.data,
          });
        } else if (parsed.type === "complete") {
          session.summary = parsed.data;
          session.currentQuestion = undefined;
          session.error = undefined;
          session.updatedAt = new Date();
          persistMissionSession(session, "complete");
          missionInterviewStreamManager.broadcast(session.id, {
            type: "summary",
            data: parsed.data,
          });
          missionInterviewStreamManager.broadcast(session.id, { type: "complete" });
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
    setMissionSessionError(session, errorMessage);
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
  rootDir: string,
  store: TaskStore,
  promptOverrides?: PromptOverrideMap,
  modelProvider?: string,
  modelId?: string,
  thinkingLevelOrProjectId?: ThinkingLevel | string | null,
  projectIdOrPluginRunner?: string | null | SkillPluginRunner,
  pluginRunnerMaybe?: SkillPluginRunner,
): Promise<string> {
  const thinkingLevel = THINKING_LEVELS.includes(thinkingLevelOrProjectId as ThinkingLevel)
    ? (thinkingLevelOrProjectId as ThinkingLevel)
    : undefined;
  const projectId = thinkingLevel
    ? (projectIdOrPluginRunner as string | null | undefined)
    : (thinkingLevelOrProjectId as string | null | undefined);
  const pluginRunner = (thinkingLevel ? pluginRunnerMaybe : projectIdOrPluginRunner) as SkillPluginRunner | undefined;
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
    projectId: projectId ?? null,
    missionId: "",
    missionTitle,
    history: [],
    thinkingOutput: "",
    lastGeneratedThinking: "",
    modelProvider,
    modelId,
    thinkingLevel,
    store,
    rootDir,
    pluginRunner,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  sessions.set(sessionId, session);
  persistMissionSession(session, "generating");

  // Initialize AI agent in background
  initializeAgent(session, rootDir, store, promptOverrides, pluginRunner).catch((err) => {
    diagnostics.errorFromException("Failed to initialize agent for session", err, { sessionId, operation: "initialize-agent" });
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
  responses: Record<string, unknown>,
  rootDir?: string,
  store?: TaskStore,
  promptOverrides?: PromptOverrideMap,
): Promise<MissionInterviewResponse> {
  const session = await getMissionInterviewSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Mission interview session ${sessionId} not found or expired`);
  }

  if (store && !session.store) session.store = store;
  if (rootDir && !session.rootDir) session.rootDir = rootDir;

  /*
  FNXC:AiSessionCancellation 2026-07-13-00:10:
  Reject an overlapping submit instead of letting generationGuard.run()'s displaced-abort teardown dispose the shared session.agent out from under this call (see GenerationInProgressError doc).
  */
  if (generationGuard.has(sessionId)) {
    throw new GenerationInProgressError("Generation already in progress for this response");
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
  session.error = undefined;
  persistMissionSession(session, "generating");

  if (!session.agent) {
    const replayHistory = session.history.slice(0, -1);
    await ensureMissionInterviewAgent(session, rootDir, store, replayHistory, promptOverrides);
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
      question: "Could you tell me more about what you want to build?",
      description: "The AI is processing your response. Please provide more details.",
    },
  };
}

export async function retryMissionInterviewSession(
  sessionId: string,
  rootDir: string,
  store?: TaskStore,
  promptOverrides?: PromptOverrideMap,
  pluginRunner?: SkillPluginRunner,
): Promise<void> {
  const session = await getMissionInterviewSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Mission interview session ${sessionId} not found or expired`);
  }

  if (store && !session.store) session.store = store;
  if (rootDir && !session.rootDir) session.rootDir = rootDir;
  session.pluginRunner = pluginRunner ?? session.pluginRunner;

  const persisted = _aiSessionStore ? await _aiSessionStore.get(sessionId) : null;
  if (persisted && persisted.type !== "mission_interview") {
    throw new SessionNotFoundError(`Mission interview session ${sessionId} not found or expired`);
  }

  const inErrorState = persisted ? persisted.status === "error" : Boolean(session.error);
  if (!inErrorState) {
    throw new InvalidSessionStateError(`Mission interview session ${sessionId} is not in an error state`);
  }

  /*
  FNXC:AiSessionCancellation 2026-07-13-00:10:
  A session can be observed in "error" (persisted status) while its original fire-and-forget
  initializeAgent() first turn is still actually in flight (createMissionInterviewSession never
  awaits it). Retrying while that generation is still registered would race two concurrent
  continueAgentConversation calls over the single shared session.agent slot. Reject cleanly instead.
  */
  if (generationGuard.has(sessionId)) {
    throw new GenerationInProgressError("Generation already in progress for this session");
  }

  disposeMissionAgentForRetry(session);

  session.error = undefined;
  session.summary = undefined;
  session.updatedAt = new Date();
  persistMissionSession(session, "generating");

  if (session.history.length === 0) {
    await ensureMissionInterviewAgent(session, rootDir, store, [], promptOverrides);
    await continueAgentConversation(
      session,
      `I want to plan a mission: "${session.missionTitle}". Interview me to understand what I need, then produce a structured plan.`,
    );
    return;
  }

  const replayHistory = session.history.slice(0, -1);
  const lastEntry = session.history[session.history.length - 1];

  await ensureMissionInterviewAgent(session, rootDir, store, replayHistory, promptOverrides);
  const replayMessage = formatResponseForAgent(
    lastEntry.question,
    coerceResponseRecord(lastEntry.question, lastEntry.response),
  );
  await continueAgentConversation(session, replayMessage);
}

export async function cancelMissionInterviewSession(sessionId: string): Promise<void> {
  const removed = cleanupInMemoryMissionSession(sessionId);
  if (!removed) {
    throw new SessionNotFoundError(`Mission interview session ${sessionId} not found or expired`);
  }

  unpersistMissionSession(sessionId);
}

export async function listMissionInterviewDrafts(projectId?: string): Promise<MissionInterviewDraftSummary[]> {
  if (!_aiSessionStore) {
    return [];
  }

  const allSessions = await _aiSessionStore.listAll(projectId);
  return allSessions
    .filter(
      (
        session,
      ): session is AiSessionSummary & { type: "mission_interview"; status: MissionInterviewDraftSummary["status"] } => {
        if (session.type !== "mission_interview") {
          return false;
        }
        if (!isMissionInterviewDraftStatus(session.status)) {
          return false;
        }
        if (projectId) {
          return session.projectId === projectId;
        }
        return session.projectId == null;
      },
    )
    .map((session) => {
      // FNXC:AiSessionStore 2026-06-25-00:15:
      // The .get() call for conversationHistory/createdAt is sync in SQLite mode.
      // We fire-and-forget it since .map() can't await. The hasConversation field
      // defaults to false; it is only used for UX display hints, not for data
      // correctness. The full row is fetched on-demand when the user opens the draft.
      return {
        id: session.id,
        title: session.title,
        status: session.status,
        projectId: session.projectId,
        createdAt: session.updatedAt,
        updatedAt: session.updatedAt,
        hasConversation: false,
      };
    });
}

function isMissionInterviewSessionInProjectScope(sessionProjectId: string | null | undefined, projectId?: string): boolean {
  if (projectId) {
    return sessionProjectId === projectId;
  }
  return sessionProjectId == null;
}

export async function discardMissionInterviewSession(sessionId: string, projectId?: string): Promise<{ removed: boolean }> {
  const hotSession = sessions.get(sessionId);
  if (hotSession) {
    if (!isMissionInterviewSessionInProjectScope(hotSession.projectId, projectId)) {
      return { removed: false };
    }
    await cancelMissionInterviewSession(sessionId);
    return { removed: true };
  }

  const persistedSession = _aiSessionStore ? await _aiSessionStore.get(sessionId) : undefined;
  if (persistedSession?.type === "mission_interview" && !isMissionInterviewSessionInProjectScope(persistedSession.projectId, projectId)) {
    return { removed: false };
  }

  /*
  FNXC:MissionDraftDiscard 2026-06-24-02:47:
  Draft discard uses the same project scope as draft listing: a project-scoped request can remove only that project's mission interview rows, and an unscoped request can remove only unscoped drafts. Ordinary planning sessions are excluded by the type guard.
  */
  const removed = _aiSessionStore ? await _aiSessionStore.deleteByIdAndType(sessionId, "mission_interview") : false;
  return { removed };
}

export async function getMissionInterviewSession(sessionId: string): Promise<MissionInterviewSession | undefined> {
  const inMemory = sessions.get(sessionId);
  if (inMemory) {
    return inMemory;
  }

  if (!_aiSessionStore) {
    return undefined;
  }

  const row = await _aiSessionStore.get(sessionId);
  if (!row || row.type !== "mission_interview") {
    return undefined;
  }

  try {
    const restored = buildMissionInterviewSessionFromRow(row);
    sessions.set(restored.id, restored);
    return restored;
  } catch (error) {
    diagnostics.errorFromException("Failed to restore session from SQLite", error, { sessionId, operation: "restore" });
    return undefined;
  }
}

export async function getMissionInterviewSummary(sessionId: string): Promise<MissionPlanSummary | undefined> {
  return (await getMissionInterviewSession(sessionId))?.summary;
}

export function cleanupMissionInterviewSession(sessionId: string): void {
  cleanupInMemoryMissionSession(sessionId);
  unpersistMissionSession(sessionId);
}

/**
 * Reset all mission interview state. Used for testing only.
 */
/**
 * Test-only: register a stub session so SSE/buffer tests can drive the stream
 * manager directly without spinning up the real AI agent (which is
 * deliberately blocked in the vitest harness).
 */
export function __registerMissionInterviewSessionForTest(sessionId: string, missionTitle = "Test Mission"): void {
  sessions.set(sessionId, {
    id: sessionId,
    ip: "127.0.0.1",
    projectId: null,
    missionId: "",
    missionTitle,
    history: [],
    thinkingOutput: "",
    lastGeneratedThinking: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export function __resetMissionInterviewState(): void {
  for (const [id] of sessions) {
    cleanupInMemoryMissionSession(id);
  }
  sessions.clear();
  rateLimits.clear();
  missionInterviewStreamManager.reset();
  generationGuard.reset();

  if (_aiSessionStore && _aiSessionDeletedListener) {
    _aiSessionStore.off("ai_session:deleted", _aiSessionDeletedListener);
  }
  _aiSessionDeletedListener = undefined;
  _aiSessionStore = undefined;

  // Reset diagnostics sink to default
  resetDiagnosticsSink();
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

/*
FNXC:AiSessionCancellation 2026-07-13-00:10:
FN-7951's onAbort teardown disposes the single shared session.agent on every abort cause, including "displaced" (a re-entrant generationGuard.run() call for the same session id). continueAgentConversation's operation reads session.agent synchronously at the start of its op closure, so a second overlapping call for the same session would observe session.agent === undefined (cleared by the first call's displaced-abort teardown) and crash with a TypeError instead of a clean, recoverable error. Reject overlapping generations up front so the shared agent handle is never raced.
*/
export class GenerationInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationInProgressError";
  }
}
