import type { TaskStore } from "@fusion/core";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AiSessionStore, AiSessionRow } from "./ai-session-store.js";
import { SessionEventBuffer, type SessionBufferedEvent } from "./sse-buffer.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createKbAgent: any;
const engineModule = "@fusion/engine";

async function initEngine() {
  if (!createKbAgent) {
    try {
      const engine = await import(/* @vite-ignore */ engineModule);
      createKbAgent = engine.createKbAgent;
    } catch {
      createKbAgent = undefined;
    }
  }
}

const engineReady = initEngine();

export interface SubtaskItem {
  id: string;
  title: string;
  description: string;
  suggestedSize: "S" | "M" | "L";
  dependsOn: string[];
}

export interface SubtaskSession {
  sessionId: string;
  initialDescription: string;
  subtasks: SubtaskItem[];
  status: "generating" | "complete" | "error";
  error?: string;
  createdAt: Date;
}

export type SubtaskStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "subtasks"; data: SubtaskItem[] }
  | { type: "error"; data: string }
  | { type: "complete" };

export type SubtaskStreamCallback = (event: SubtaskStreamEvent, eventId?: number) => void;

const SESSION_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const sessions = new Map<string, SubtaskSession & { updatedAt: Date; agent?: any; thinkingOutput: string }>();

// ── AI Session Persistence ────────────────────────────────────────────────

let _aiSessionStore: AiSessionStore | undefined;

export function setAiSessionStore(store: AiSessionStore): void {
  _aiSessionStore = store;
}

type SubtaskInternalSession = SubtaskSession & { updatedAt: Date; agent?: any; thinkingOutput: string };

function persistSubtaskSession(session: SubtaskInternalSession, status: "generating" | "complete" | "error", error?: string): void {
  if (!_aiSessionStore) return;
  const row: AiSessionRow = {
    id: session.sessionId,
    type: "subtask",
    status,
    title: session.initialDescription.slice(0, 120),
    inputPayload: JSON.stringify({ initialDescription: session.initialDescription }),
    conversationHistory: "[]",
    currentQuestion: null,
    result: session.subtasks.length > 0 ? JSON.stringify(session.subtasks) : null,
    thinkingOutput: session.thinkingOutput,
    error: error ?? session.error ?? null,
    projectId: null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: new Date().toISOString(),
  };
  _aiSessionStore.upsert(row);
}

function persistSubtaskThinking(sessionId: string, thinkingOutput: string): void {
  if (!_aiSessionStore) return;
  _aiSessionStore.updateThinking(sessionId, thinkingOutput);
}

function unpersistSubtaskSession(sessionId: string): void {
  if (!_aiSessionStore) return;
  _aiSessionStore.delete(sessionId);
}

export const SUBTASK_BREAKDOWN_PROMPT = `You are a task decomposition assistant for the kb task board system.

Analyze the user's task description and break it down into 2-5 smaller, independently executable subtasks.

For each subtask, provide:
1. Title (short and descriptive)
2. Description (1-2 sentences, implementation-focused)
3. Size estimate (S: <2h, M: 2-4h, L: 4-8h)
4. Dependencies (which other subtask IDs must be completed first)

Guidelines:
- Prefer parallelizable subtasks when possible
- Only add dependencies when truly required
- Order subtasks so prerequisites appear earlier
- Keep the overall scope aligned with the original task
- Use IDs like "subtask-1", "subtask-2", etc.

Return ONLY valid JSON in this format:
{
  "subtasks": [
    {
      "id": "subtask-1",
      "title": "...",
      "description": "...",
      "suggestedSize": "S",
      "dependsOn": []
    }
  ]
}`;

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.updatedAt.getTime() > SESSION_TTL_MS) {
      try {
        session.agent?.session?.dispose?.();
      } catch {
        // ignore cleanup failures
      }
      sessions.delete(id);
      subtaskStreamManager.cleanupSession(id);
    }
  }
}

const cleanupInterval = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
process.on("beforeExit", () => {
  clearInterval(cleanupInterval);
});

export class SubtaskStreamManager extends EventEmitter {
  private readonly sessions = new Map<string, Set<SubtaskStreamCallback>>();
  private readonly buffers = new Map<string, SessionEventBuffer>();

  constructor(private readonly bufferSize = 100) {
    super();
  }

  subscribe(sessionId: string, callback: SubtaskStreamCallback): () => void {
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

  broadcast(sessionId: string, event: SubtaskStreamEvent): number {
    const serialized = JSON.stringify((event as { data?: unknown }).data ?? {});
    const eventData = typeof serialized === "string" ? serialized : "{}";
    const eventId = this.getBuffer(sessionId).push(event.type, eventData);

    const callbacks = this.sessions.get(sessionId);
    if (!callbacks) return eventId;

    for (const callback of callbacks) {
      try {
        callback(event, eventId);
      } catch {
        // ignore subscriber failures
      }
    }

    return eventId;
  }

  getBufferedEvents(sessionId: string, sinceId: number): SessionBufferedEvent[] {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return [];
    return buffer.getEventsSince(sinceId);
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

export const subtaskStreamManager = new SubtaskStreamManager();

export async function createSubtaskSession(initialDescription: string, _store?: TaskStore, rootDir?: string): Promise<SubtaskSession> {
  const sessionId = randomUUID();
  const session = {
    sessionId,
    initialDescription,
    subtasks: [],
    status: "generating" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    thinkingOutput: "",
  };
  sessions.set(sessionId, session);
  persistSubtaskSession(session, "generating");

  const cwd = rootDir ?? process.cwd();
  generateSubtasks(sessionId, cwd).catch((err) => {
    const existing = sessions.get(sessionId);
    if (!existing) return;
    existing.status = "error";
    existing.error = err instanceof Error ? (err.message || "Unknown error") : "Failed to generate subtasks";
    existing.updatedAt = new Date();
    persistSubtaskSession(existing, "error", existing.error);
    subtaskStreamManager.broadcast(sessionId, { type: "error", data: existing.error });
  });

  return {
    sessionId,
    initialDescription,
    subtasks: [],
    status: "generating",
    createdAt: session.createdAt,
  };
}

async function generateSubtasks(sessionId: string, cwd: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new SessionNotFoundError(`Subtask session ${sessionId} not found`);

  await engineReady;

  if (createKbAgent) {
    const agent = await createKbAgent({
      cwd,
      systemPrompt: SUBTASK_BREAKDOWN_PROMPT,
      tools: "readonly",
      onThinking: (delta: string) => {
        const current = sessions.get(sessionId);
        if (!current) return;
        current.thinkingOutput += delta;
        current.updatedAt = new Date();
        persistSubtaskThinking(sessionId, current.thinkingOutput);
        subtaskStreamManager.broadcast(sessionId, { type: "thinking", data: delta });
      },
      onText: (delta: string) => {
        const current = sessions.get(sessionId);
        if (!current) return;
        current.thinkingOutput += delta;
      },
    });

    session.agent = agent;
    await agent.session.prompt(session.initialDescription);

    const messages = agent.session.state.messages as Array<{ role: string; content?: string | Array<{ type: string; text: string }> }>;
    const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
    let responseText = session.thinkingOutput;
    if (typeof lastAssistant?.content === "string") {
      responseText = lastAssistant.content;
    } else if (Array.isArray(lastAssistant?.content)) {
      responseText = lastAssistant.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("");
    }

    const subtasks = parseSubtasks(responseText);
    completeSession(sessionId, subtasks);
    return;
  }

  const fallback = generateFallbackSubtasks(session.initialDescription);
  completeSession(sessionId, fallback);
}

function parseSubtasks(text: string): SubtaskItem[] {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
  const jsonText = jsonMatch ? jsonMatch[1] || jsonMatch[0] : text;
  const parsed = JSON.parse(jsonText.trim()) as { subtasks?: SubtaskItem[] };
  if (!Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
    throw new Error("AI did not return a valid subtasks array");
  }
  return parsed.subtasks.map(normalizeSubtaskItem);
}

function normalizeSubtaskItem(item: SubtaskItem, index = 0): SubtaskItem {
  return {
    id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `subtask-${index + 1}`,
    title: typeof item.title === "string" ? item.title.trim() : "",
    description: typeof item.description === "string" ? item.description.trim() : "",
    suggestedSize: item.suggestedSize === "S" || item.suggestedSize === "M" || item.suggestedSize === "L" ? item.suggestedSize : "M",
    dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.filter((dep): dep is string => typeof dep === "string") : [],
  };
}

function generateFallbackSubtasks(initialDescription: string): SubtaskItem[] {
  return [
    {
      id: "subtask-1",
      title: "Define implementation approach",
      description: `Clarify scope and technical approach for: ${initialDescription}`,
      suggestedSize: "S",
      dependsOn: [],
    },
    {
      id: "subtask-2",
      title: "Implement core changes",
      description: "Build the main functionality required by the task description.",
      suggestedSize: "M",
      dependsOn: ["subtask-1"],
    },
    {
      id: "subtask-3",
      title: "Verify and polish",
      description: "Add tests, validation, and any follow-up cleanup needed for delivery.",
      suggestedSize: "S",
      dependsOn: ["subtask-2"],
    },
  ];
}

function completeSession(sessionId: string, subtasks: SubtaskItem[]): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.subtasks = subtasks.map(normalizeSubtaskItem);
  session.status = "complete";
  session.error = undefined;
  session.updatedAt = new Date();
  persistSubtaskSession(session, "complete");
  subtaskStreamManager.broadcast(sessionId, { type: "subtasks", data: session.subtasks });
  subtaskStreamManager.broadcast(sessionId, { type: "complete" });
}

export function getSubtaskSession(sessionId: string): SubtaskSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  return {
    sessionId: session.sessionId,
    initialDescription: session.initialDescription,
    subtasks: session.subtasks,
    status: session.status,
    error: session.error,
    createdAt: session.createdAt,
  };
}

export async function cancelSubtaskSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Subtask session ${sessionId} not found or expired`);
  }
  try {
    session.agent?.session?.dispose?.();
  } catch {
    // ignore dispose errors
  }
  subtaskStreamManager.cleanupSession(sessionId);
  sessions.delete(sessionId);
  unpersistSubtaskSession(sessionId);
}

export function cleanupSubtaskSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  try {
    session?.agent?.session?.dispose?.();
  } catch {
    // ignore cleanup errors
  }
  subtaskStreamManager.cleanupSession(sessionId);
  sessions.delete(sessionId);
  unpersistSubtaskSession(sessionId);
}

export function __resetSubtaskBreakdownState(): void {
  for (const [, session] of sessions) {
    try {
      session.agent?.session?.dispose?.();
    } catch {
      // ignore cleanup errors
    }
  }
  sessions.clear();
  subtaskStreamManager.reset();
}

export class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotFoundError";
  }
}
