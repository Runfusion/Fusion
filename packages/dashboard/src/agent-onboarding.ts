import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentCapability, PlanningQuestion } from "@fusion/core";
import { resolvePrompt, type PromptOverrideMap } from "@fusion/core";
import { createFnAgent as engineCreateFnAgent } from "@fusion/engine";
import { SessionEventBuffer, type SessionBufferedEvent } from "./sse-buffer.js";

export interface AgentOnboardingSummary {
  name: string;
  role: AgentCapability | "custom";
  instructionsText: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
  maxTurns: number;
  title?: string;
  icon?: string;
  reportsTo?: string;
  soul?: string;
  memory?: string;
  skills?: string[];
  templateId?: string;
  patternAgentId?: string;
  rationale?: string;
  model?: string;
  /** Draft-only AI suggestion for eventual runtimeConfig.model selection. */
  modelHint?: string;
  /** Draft-only AI suggestion for eventual runtimeConfig.runtimeHint plugin runtime selection. */
  runtimeHint?: string;
  heartbeatProcedurePath?: string;
  heartbeatIntervalMs?: number;
  heartbeatEnabled?: boolean;
}

export type OnboardingMode = "create" | "edit";

export interface ExistingAgentOnboardingConfig {
  name?: string;
  role?: AgentCapability | "custom";
  title?: string;
  instructionsText?: string;
  soul?: string;
  memory?: string;
  reportsTo?: string;
  skills?: string[];
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  maxTurns?: number;
  runtimeHint?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxConcurrentRuns?: number;
  messageResponseMode?: "immediate" | "on-heartbeat";
}

export type AgentOnboardingStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "question"; data: PlanningQuestion }
  | { type: "summary"; data: AgentOnboardingSummary }
  | { type: "error"; data: string }
  | { type: "complete" };

export type AgentOnboardingStreamCallback = (event: AgentOnboardingStreamEvent, eventId?: number) => void;

const createFnAgent: typeof engineCreateFnAgent = engineCreateFnAgent;
const SESSION_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const GENERATION_TIMEOUT_MS = 120_000;

export const AGENT_ONBOARDING_SYSTEM_PROMPT = `You are an agent onboarding assistant for the fn task board system.

Your job is to guide users through creating a new agent with a short interview.
Use the provided context (existing agents + template options) to make concrete suggestions.

Ask targeted questions using this JSON format:
{"type":"question","data":{"id":"q1","type":"text|single_select|multi_select|confirm","question":"...","description":"...","options":[{"id":"x","label":"X","description":"..."}]}}

When ready, return a final summary JSON in this exact format:
{"type":"complete","data":{"name":"...","role":"executor","instructionsText":"...","thinkingLevel":"medium","maxTurns":25,"title":"...","icon":"🤖","reportsTo":"...","soul":"...","memory":"...","skills":["..."],"templateId":"...","patternAgentId":"...","rationale":"...","heartbeatProcedurePath":"...","heartbeatIntervalMs":30000,"heartbeatEnabled":true,"modelHint":"...","runtimeHint":"..."}}

Rules:
- role must be one of triage|executor|reviewer|merger|scheduler|engineer|custom
- thinkingLevel must be off|minimal|low|medium|high
- maxTurns must be a positive integer
- Use instructionsText for starter operating guidance/playbook content; do not create a separate playbook field
- modelHint and runtimeHint are optional draft suggestions only (not final runtime selection)
- heartbeatProcedurePath, heartbeatIntervalMs, and heartbeatEnabled are optional draft hints only.`;

type OnboardingAgent = Awaited<ReturnType<typeof engineCreateFnAgent>>;

interface Session {
  id: string;
  ip: string;
  mode: OnboardingMode;
  contextPrompt: string;
  currentQuestion?: PlanningQuestion;
  summary?: AgentOnboardingSummary;
  error?: string;
  history: Array<{ question: PlanningQuestion; response: Record<string, unknown> }>;
  thinkingOutput: string;
  agent?: OnboardingAgent;
  createdAt: Date;
  updatedAt: Date;
}

const sessions = new Map<string, Session>();
const activeGenerations = new Map<string, { abortController: AbortController; timer: NodeJS.Timeout }>();

export class AgentOnboardingStreamManager extends EventEmitter {
  private readonly sessions = new Map<string, Set<AgentOnboardingStreamCallback>>();
  private readonly buffers = new Map<string, SessionEventBuffer>();

  subscribe(sessionId: string, callback: AgentOnboardingStreamCallback): () => void {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new Set());
    const callbacks = this.sessions.get(sessionId)!;
    callbacks.add(callback);
    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) this.sessions.delete(sessionId);
    };
  }

  private getBuffer(sessionId: string): SessionEventBuffer {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = new SessionEventBuffer(100);
      this.buffers.set(sessionId, buffer);
    }
    return buffer;
  }

  broadcast(sessionId: string, event: AgentOnboardingStreamEvent): number {
    const serialized = JSON.stringify((event as { data?: unknown }).data ?? {});
    const eventId = this.getBuffer(sessionId).push(event.type, serialized);
    const callbacks = this.sessions.get(sessionId);
    if (!callbacks) return eventId;
    for (const callback of callbacks) callback(event, eventId);
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
}

export const agentOnboardingStreamManager = new AgentOnboardingStreamManager();

function extractJsonCandidate(text: string): string | null {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) return codeBlockMatch[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return text.trim().startsWith("{") ? text.trim() : null;
}

function repairJson(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

export function parseAgentOnboardingResponse(text: string): { type: "question"; data: PlanningQuestion } | { type: "complete"; data: AgentOnboardingSummary } {
  const candidate = extractJsonCandidate(text);
  if (!candidate) throw new Error("AI returned no valid JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    parsed = JSON.parse(repairJson(candidate));
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    throw new Error("AI returned invalid response type");
  }

  const typed = parsed as { type?: unknown; data?: unknown };
  if (typed.type !== "question" && typed.type !== "complete") {
    throw new Error("AI returned invalid response type");
  }

  if (typed.type === "complete") {
    const data = (typed.data ?? {}) as AgentOnboardingSummary & {
      name?: unknown;
      instructionsText?: unknown;
      maxTurns?: unknown;
      heartbeatProcedurePath?: unknown;
      heartbeatIntervalMs?: unknown;
      heartbeatEnabled?: unknown;
      modelHint?: unknown;
      runtimeHint?: unknown;
    };
    if (typeof data.name !== "string" || !data.name.trim()) throw new Error("Invalid summary.name");
    if (typeof data.instructionsText !== "string" || !data.instructionsText.trim()) throw new Error("Invalid summary.instructionsText");
    const maxTurns = data.maxTurns;
    if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns <= 0) {
      throw new Error("Invalid summary.maxTurns");
    }

    if (data.heartbeatProcedurePath !== undefined) {
      if (typeof data.heartbeatProcedurePath !== "string" || !data.heartbeatProcedurePath.trim()) {
        throw new Error("Invalid summary.heartbeatProcedurePath");
      }
      data.heartbeatProcedurePath = data.heartbeatProcedurePath.trim();
    }

    if (data.heartbeatIntervalMs !== undefined) {
      if (typeof data.heartbeatIntervalMs !== "number" || !Number.isInteger(data.heartbeatIntervalMs) || data.heartbeatIntervalMs <= 0) {
        throw new Error("Invalid summary.heartbeatIntervalMs");
      }
    }

    if (data.heartbeatEnabled !== undefined && typeof data.heartbeatEnabled !== "boolean") {
      throw new Error("Invalid summary.heartbeatEnabled");
    }

    if (data.modelHint !== undefined && typeof data.modelHint !== "string") {
      throw new Error("Invalid summary.modelHint");
    }

    if (data.runtimeHint !== undefined && typeof data.runtimeHint !== "string") {
      throw new Error("Invalid summary.runtimeHint");
    }

    return { type: "complete", data: data as AgentOnboardingSummary };
  }

  return { type: "question", data: typed.data as PlanningQuestion };
}

export function createAgentOnboardingSessionPrompt(input: {
  mode: OnboardingMode;
  intent: string;
  existingAgents: Array<{ id: string; name: string; role: string }>;
  templates: Array<{ id: string; label: string; description?: string }>;
  existingAgentConfig?: ExistingAgentOnboardingConfig;
}): string {
  const compactAgents = input.existingAgents.slice(0, 25).map((a) => `${a.id}:${a.name}(${a.role})`).join("\n") || "none";
  const compactTemplates = input.templates.slice(0, 25).map((t) => `${t.id}:${t.label}${t.description ? ` - ${t.description}` : ""}`).join("\n") || "none";
  const createContext = `User intent:\n${input.intent}\n\nExisting agents:\n${compactAgents}\n\nTemplate/preset options:\n${compactTemplates}`;

  if (input.mode === "create") {
    return createContext;
  }

  const currentConfig = input.existingAgentConfig ?? {};
  const currentConfigLines = [
    `name: ${currentConfig.name ?? ""}`,
    `role: ${currentConfig.role ?? ""}`,
    `title: ${currentConfig.title ?? ""}`,
    `instructionsText: ${currentConfig.instructionsText ?? ""}`,
    `soul: ${currentConfig.soul ?? ""}`,
    `memory: ${currentConfig.memory ?? ""}`,
    `reportsTo: ${currentConfig.reportsTo ?? ""}`,
    `skills: ${(currentConfig.skills ?? []).join(", ")}`,
    `model: ${currentConfig.model ?? ""}`,
    `thinkingLevel: ${currentConfig.thinkingLevel ?? ""}`,
    `maxTurns: ${currentConfig.maxTurns ?? ""}`,
    `runtimeHint: ${currentConfig.runtimeHint ?? ""}`,
    `heartbeatIntervalMs: ${currentConfig.heartbeatIntervalMs ?? ""}`,
    `heartbeatTimeoutMs: ${currentConfig.heartbeatTimeoutMs ?? ""}`,
    `maxConcurrentRuns: ${currentConfig.maxConcurrentRuns ?? ""}`,
    `messageResponseMode: ${currentConfig.messageResponseMode ?? ""}`,
  ].join("\n");

  return `${createContext}\n\nCurrent agent configuration:\n${currentConfigLines}`;
}

export async function startAgentOnboardingSession(
  ip: string,
  initialContext: {
    mode?: OnboardingMode;
    intent: string;
    existingAgents: Array<{ id: string; name: string; role: string }>;
    templates: Array<{ id: string; label: string; description?: string }>;
    existingAgentConfig?: ExistingAgentOnboardingConfig;
  },
  rootDir: string,
  modelProvider?: string,
  modelId?: string,
  promptOverrides?: PromptOverrideMap,
): Promise<string> {
  const id = randomUUID();
  const mode: OnboardingMode = initialContext.mode ?? "create";
  const session: Session = {
    id,
    ip,
    mode,
    contextPrompt: createAgentOnboardingSessionPrompt({
      mode,
      intent: initialContext.intent,
      existingAgents: initialContext.existingAgents,
      templates: initialContext.templates,
      existingAgentConfig: initialContext.existingAgentConfig,
    }),
    history: [],
    thinkingOutput: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  sessions.set(id, session);

  const systemPrompt = resolvePrompt("agent-onboarding-system", promptOverrides) || AGENT_ONBOARDING_SYSTEM_PROMPT;
  session.agent = await createFnAgent({
    cwd: rootDir,
    systemPrompt,
    tools: "readonly",
    ...(modelProvider && modelId ? { defaultProvider: modelProvider, defaultModelId: modelId } : {}),
    onThinking: (delta: string) => {
      session.thinkingOutput += delta;
      agentOnboardingStreamManager.broadcast(session.id, { type: "thinking", data: delta });
    },
    onText: (delta: string) => {
      session.thinkingOutput += delta;
      agentOnboardingStreamManager.broadcast(session.id, { type: "thinking", data: delta });
    },
  });

  void continueConversation(session, session.contextPrompt);
  return id;
}

async function runGenerationWithTimeout<T>(session: Session, operation: () => Promise<T>): Promise<T> {
  const existing = activeGenerations.get(session.id);
  if (existing) {
    clearTimeout(existing.timer);
    existing.abortController.abort();
  }
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    session.error = "AI generation timed out. You can retry.";
    agentOnboardingStreamManager.broadcast(session.id, { type: "error", data: session.error });
    abortController.abort();
  }, GENERATION_TIMEOUT_MS);
  activeGenerations.set(session.id, { abortController, timer });
  try {
    return await operation();
  } finally {
    clearTimeout(timer);
    activeGenerations.delete(session.id);
  }
}

async function continueConversation(session: Session, message: string): Promise<void> {
  if (!session.agent) throw new Error("Session agent not initialized");
  const agent = session.agent;
  session.thinkingOutput = "";
  try {
    await runGenerationWithTimeout(session, async () => {
      await agent.session.prompt(message);
      const assistant = (agent.session.state.messages as Array<{ role: string; content?: string | Array<{ type: string; text: string }> }>).filter((m) => m.role === "assistant").pop();
      let responseText = session.thinkingOutput;
      if (assistant?.content) {
        if (typeof assistant.content === "string") responseText = assistant.content;
        else responseText = assistant.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      }
      const parsed = parseAgentOnboardingResponse(responseText);
      session.error = undefined;
      session.updatedAt = new Date();
      if (parsed.type === "question") {
        session.currentQuestion = parsed.data;
        agentOnboardingStreamManager.broadcast(session.id, { type: "question", data: parsed.data });
      } else {
        session.summary = parsed.data;
        session.currentQuestion = undefined;
        agentOnboardingStreamManager.broadcast(session.id, { type: "summary", data: parsed.data });
        agentOnboardingStreamManager.broadcast(session.id, { type: "complete" });
      }
    });
  } catch (err) {
    session.error = err instanceof Error ? err.message : String(err);
    agentOnboardingStreamManager.broadcast(session.id, { type: "error", data: session.error });
  }
}

export async function respondToAgentOnboarding(sessionId: string, responses: Record<string, unknown>): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new SessionNotFoundError(`Agent onboarding session ${sessionId} not found or expired`);
  if (!session.currentQuestion) throw new InvalidSessionStateError("No active question in session");
  session.history.push({ question: session.currentQuestion, response: responses });
  const formatted = `Question: ${session.currentQuestion.question}\nAnswer: ${JSON.stringify(responses)}`;
  await continueConversation(session, formatted);
}

export async function retryAgentOnboardingSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new SessionNotFoundError(`Agent onboarding session ${sessionId} not found or expired`);
  if (!session.error) throw new InvalidSessionStateError("Session is not in an error state");
  session.error = undefined;
  const retryPrompt = session.currentQuestion
    ? `Please continue from the last question: ${session.currentQuestion.question}`
    : "Please continue and ask the next best onboarding question.";
  await continueConversation(session, retryPrompt);
}

export function stopAgentOnboardingGeneration(sessionId: string): boolean {
  const active = activeGenerations.get(sessionId);
  if (!active) return false;
  clearTimeout(active.timer);
  active.abortController.abort();
  activeGenerations.delete(sessionId);
  const session = sessions.get(sessionId);
  if (session) {
    session.error = "Generation stopped by user. You can retry.";
    agentOnboardingStreamManager.broadcast(session.id, { type: "error", data: session.error });
  }
  return true;
}

export async function cancelAgentOnboardingSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new SessionNotFoundError(`Agent onboarding session ${sessionId} not found or expired`);
  stopAgentOnboardingGeneration(sessionId);
  try { session.agent?.session.dispose?.(); } catch { /* ignore dispose errors */ }
  sessions.delete(sessionId);
  agentOnboardingStreamManager.cleanupSession(sessionId);
}

export function getAgentOnboardingSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function getAgentOnboardingSummary(sessionId: string): AgentOnboardingSummary | undefined {
  return sessions.get(sessionId)?.summary;
}

export function __resetAgentOnboardingState(): void {
  for (const sessionId of sessions.keys()) {
    void cancelAgentOnboardingSession(sessionId).catch(() => {});
  }
  sessions.clear();
  activeGenerations.clear();
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.updatedAt.getTime() > SESSION_TTL_MS) {
      void cancelAgentOnboardingSession(id).catch(() => {});
    }
  }
}, CLEANUP_INTERVAL_MS).unref?.();

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
