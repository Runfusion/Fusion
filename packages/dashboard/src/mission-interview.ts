/**
 * Mission Interview Session Management
 *
 * Manages AI-guided interview sessions for mission specification.
 * Mirrors the planning session architecture but produces mission hierarchy
 * data (milestones, slices, features) instead of task summaries.
 *
 * Sessions are stored in-memory with TTL cleanup.
 *
 * Features:
 * - Stubbed question flow (scope -> objectives -> dependencies -> summary)
 * - Rate limiting per IP
 * - Session expiration and cleanup
 * - SSE streaming via MissionInterviewStreamManager
 */

import type { PlanningQuestion } from "@fusion/core";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

// ── Constants ───────────────────────────────────────────────────────────────

/** Session TTL in milliseconds (30 minutes) */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Cleanup interval in milliseconds (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Max interview sessions per IP per hour */
const MAX_SESSIONS_PER_IP_PER_HOUR = 5;

/** Rate limiting window in milliseconds (1 hour) */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

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
  features: MissionPlanFeature[];
}

/** A milestone in the generated plan */
export interface MissionPlanMilestone {
  title: string;
  description?: string;
  slices: MissionPlanSlice[];
}

/** The complete mission plan summary produced by the interview */
export interface MissionPlanSummary {
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

// ── Cleanup Interval ────────────────────────────────────────────────────────

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.updatedAt.getTime() > SESSION_TTL_MS) {
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

// ── Stubbed Question Generation ─────────────────────────────────────────────

function generateFirstQuestion(missionTitle: string): PlanningQuestion {
  return {
    id: "q-scope",
    type: "single_select",
    question: `What is the scope of "${missionTitle}"?`,
    description: "This helps determine how many milestones and slices the mission needs.",
    options: [
      { id: "small", label: "Small - 1 milestone, 1-2 slices", description: "Focused objective" },
      { id: "medium", label: "Medium - 2-3 milestones, multiple slices", description: "Standard project" },
      { id: "large", label: "Large - 3+ milestones, many slices", description: "Complex initiative" },
    ],
  };
}

function generateNextQuestionOrSummary(session: MissionInterviewSession): MissionInterviewResponse {
  const historyLength = session.history.length;

  if (historyLength < 2) {
    return {
      type: "question",
      data: {
        id: "q-objectives",
        type: "text",
        question: "What are the key objectives or deliverables for this mission?",
        description: "Describe the main things that need to be built or achieved. Each objective may become a milestone.",
      },
    };
  }

  if (historyLength < 3) {
    return {
      type: "question",
      data: {
        id: "q-confirm",
        type: "confirm",
        question: "Are there dependencies between the milestones that require a specific ordering?",
        description: "If yes, the milestones will be ordered sequentially. Otherwise they can be worked in parallel.",
      },
    };
  }

  return { type: "complete", data: generateMissionPlanSummary(session) };
}

function generateMissionPlanSummary(session: MissionInterviewSession): MissionPlanSummary {
  const scopeResponse = session.history.find((h) => h.question.id === "q-scope")?.response as
    | Record<string, unknown>
    | undefined;
  const scope = (scopeResponse?.["q-scope"] as string) || "medium";

  const objectivesResponse = session.history.find((h) => h.question.id === "q-objectives")?.response as
    | Record<string, unknown>
    | undefined;
  const objectives = (objectivesResponse?.["q-objectives"] as string) || "";

  // Generate hierarchy based on scope
  if (scope === "small") {
    return {
      milestones: [
        {
          title: `${session.missionTitle} - Core Implementation`,
          description: objectives || undefined,
          slices: [
            {
              title: "Implementation",
              description: `Core implementation for ${session.missionTitle}`,
              features: [
                { title: "Core functionality", description: "Implement the main feature" },
                { title: "Tests", description: "Add test coverage" },
              ],
            },
          ],
        },
      ],
    };
  }

  if (scope === "large") {
    return {
      milestones: [
        {
          title: "Foundation & Setup",
          description: "Initial scaffolding and infrastructure",
          slices: [
            {
              title: "Infrastructure",
              features: [
                { title: "Project scaffolding", description: "Set up project structure" },
                { title: "Configuration", description: "Configure build and tooling" },
              ],
            },
          ],
        },
        {
          title: "Core Implementation",
          description: objectives || "Main feature development",
          slices: [
            {
              title: "Primary features",
              features: [
                { title: "Core feature 1", description: "First major deliverable" },
                { title: "Core feature 2", description: "Second major deliverable" },
              ],
            },
            {
              title: "Secondary features",
              features: [
                { title: "Supporting feature", description: "Supporting functionality" },
              ],
            },
          ],
        },
        {
          title: "Polish & Release",
          description: "Testing, documentation, and release preparation",
          slices: [
            {
              title: "Quality assurance",
              features: [
                { title: "Integration tests", description: "End-to-end test coverage" },
                { title: "Documentation", description: "User and developer documentation" },
              ],
            },
          ],
        },
      ],
    };
  }

  // Medium (default)
  return {
    milestones: [
      {
        title: "Phase 1 - Setup & Core",
        description: "Initial setup and core functionality",
        slices: [
          {
            title: "Core implementation",
            description: objectives || `Core work for ${session.missionTitle}`,
            features: [
              { title: "Core functionality", description: "Implement the main feature" },
              { title: "Basic tests", description: "Add initial test coverage" },
            ],
          },
        ],
      },
      {
        title: "Phase 2 - Integration & Delivery",
        description: "Integration, polish, and delivery",
        slices: [
          {
            title: "Integration",
            features: [
              { title: "Integration work", description: "Connect components together" },
              { title: "Final tests & docs", description: "Complete test coverage and documentation" },
            ],
          },
        ],
      },
    ],
  };
}

// ── Session Management ──────────────────────────────────────────────────────

export async function createMissionInterviewSession(
  ip: string,
  missionId: string,
  missionTitle: string
): Promise<{ sessionId: string; firstQuestion: PlanningQuestion }> {
  if (!checkRateLimit(ip)) {
    const resetTime = getRateLimitResetTime(ip);
    throw new RateLimitError(
      `Rate limit exceeded. Maximum ${MAX_SESSIONS_PER_IP_PER_HOUR} sessions per hour. ` +
        `Reset at ${resetTime?.toISOString() || "unknown"}`
    );
  }

  const sessionId = randomUUID();
  const firstQuestion = generateFirstQuestion(missionTitle);

  const session: MissionInterviewSession = {
    id: sessionId,
    ip,
    missionId,
    missionTitle,
    history: [],
    currentQuestion: firstQuestion,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  sessions.set(sessionId, session);

  return { sessionId, firstQuestion };
}

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

  session.history.push({
    question: session.currentQuestion,
    response: responses,
  });

  const result = generateNextQuestionOrSummary(session);

  if (result.type === "question") {
    session.currentQuestion = result.data;
  } else {
    session.summary = result.data;
    session.currentQuestion = undefined;
  }

  session.updatedAt = new Date();
  return result;
}

export async function cancelMissionInterviewSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Mission interview session ${sessionId} not found or expired`);
  }

  missionInterviewStreamManager.cleanupSession(sessionId);
  sessions.delete(sessionId);
}

export function getMissionInterviewSession(sessionId: string): MissionInterviewSession | undefined {
  return sessions.get(sessionId);
}

export function getMissionInterviewSummary(sessionId: string): MissionPlanSummary | undefined {
  return sessions.get(sessionId)?.summary;
}

export function cleanupMissionInterviewSession(sessionId: string): void {
  missionInterviewStreamManager.cleanupSession(sessionId);
  sessions.delete(sessionId);
}

/**
 * Reset all mission interview state. Used for testing only.
 */
export function __resetMissionInterviewState(): void {
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
