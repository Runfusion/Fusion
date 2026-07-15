import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentCapability, PlanningQuestion, TaskStore } from "@fusion/core";
import { resolvePrompt, type PromptOverrideMap } from "@fusion/core";
import { buildSessionSkillContextSync, createFnAgent as engineCreateFnAgent, resolveMcpServersForStore } from "@fusion/engine";
import { SessionEventBuffer, type SessionBufferedEvent } from "./sse-buffer.js";

export interface AgentOnboardingSummary {
  name: string;
  role: AgentCapability | "custom";
  instructionsText: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
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
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
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
type SkillSelectionPluginRunner = Parameters<typeof buildSessionSkillContextSync>[3];
const SESSION_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const GENERATION_TIMEOUT_MS = 120_000;
const REFORMAT_PROMPT =
  "Your previous response could not be parsed as JSON. " +
  'Respond with ONLY one valid JSON object using either {"type":"question","data":{...}} or {"type":"complete","data":{...}}. ' +
  "No markdown, no explanation, just the JSON.";

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
- Prefer structuring instructionsText with these markdown sections when drafting: ## Description, ## Expertise, ## Priorities, ## Boundaries, ## Communication, ## Collaboration & Escalation
- Freeform instructionsText is still acceptable for compatibility; sectioned structure is preferred for new agents
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
  rootDir: string;
  modelProvider?: string;
  modelId?: string;
  promptOverrides?: PromptOverrideMap;
  pluginRunner?: SkillSelectionPluginRunner;
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
  pluginRunner?: SkillSelectionPluginRunner,
  store?: TaskStore,
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
    rootDir,
    modelProvider,
    modelId,
    promptOverrides,
    pluginRunner,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  sessions.set(id, session);

  session.agent = await createAgentOnboardingAgent(session, store);

  void continueConversation(session, session.contextPrompt);
  return id;
}

async function createAgentOnboardingAgent(session: Session, store?: TaskStore): Promise<OnboardingAgent> {
  const systemPrompt = resolvePrompt("agent-onboarding-system", session.promptOverrides) || AGENT_ONBOARDING_SYSTEM_PROMPT;
  const skillContext = buildSessionSkillContextSync(null, "executor", session.rootDir, session.pluginRunner);
  const mcpServers = (await resolveMcpServersForStore(store ?? {})).servers;
  /*
   * FNXC:McpConfig 2026-06-26-17:26:
   * Agent onboarding interviews are dashboard readonly planning helpers. Resolve MCP from the request-scoped TaskStore when routes can provide it; no-store callers stay empty and this seam must not log secret material.
   *
   * FNXC:McpConfig 2026-06-26-18:10:
   * Retry can recover a session whose agent was not initialized, so the retry route must pass its scoped TaskStore into this same createFnAgent seam instead of continuing with secret-less defaults.
   */
  return createFnAgent({
    cwd: session.rootDir,
    systemPrompt,
    tools: "readonly",
    mcpServers,
    ...(session.modelProvider && session.modelId ? { defaultProvider: session.modelProvider, defaultModelId: session.modelId } : {}),
    /*
    FNXC:InterviewSkills 2026-06-17-21:53:
    Agent onboarding is a model-only dashboard interview lane, so it must request executor role-fallback skills plus enabled plugin skills such as ce-debug like other agent-acting sessions.
    */
    ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    onThinking: (delta: string) => {
      session.thinkingOutput += delta;
      agentOnboardingStreamManager.broadcast(session.id, { type: "thinking", data: delta });
    },
    onText: (delta: string) => {
      session.thinkingOutput += delta;
      agentOnboardingStreamManager.broadcast(session.id, { type: "thinking", data: delta });
    },
  });
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

type OnboardingMessage = {
  role: string;
  content?: string | Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: string }
  >;
};

function extractLastAssistantResponse(messages: unknown[], streamedOutput: string): string {
  const assistant = (messages as OnboardingMessage[]).filter((message) => message.role === "assistant").pop();
  if (typeof assistant?.content === "string") return assistant.content;
  if (!Array.isArray(assistant?.content)) return streamedOutput;

  const textContent = assistant.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  const thinkingContent = assistant.content
    .filter((block): block is { type: "thinking"; thinking: string } => block.type === "thinking" && "thinking" in block && typeof block.thinking === "string")
    .map((block) => block.thinking)
    .join("");
  return textContent || thinkingContent || streamedOutput;
}

async function continueConversation(session: Session, message: string): Promise<void> {
  if (!session.agent) throw new Error("Session agent not initialized");
  const agent = session.agent;
  session.thinkingOutput = "";
  try {
    await runGenerationWithTimeout(session, async () => {
      await agent.session.prompt(message);
      let responseText = extractLastAssistantResponse(agent.session.state.messages, session.thinkingOutput);
      let parsed: ReturnType<typeof parseAgentOnboardingResponse>;
      try {
        parsed = parseAgentOnboardingResponse(responseText);
      } catch {
        session.thinkingOutput = "";
        await agent.session.prompt(REFORMAT_PROMPT);
        responseText = extractLastAssistantResponse(agent.session.state.messages, session.thinkingOutput);
        parsed = parseAgentOnboardingResponse(responseText);
      }
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

/*
FNXC:AgentOnboarding 2026-07-14-18:20:
When generation fails after an answer is accepted, summary and currentQuestion are both empty.
The respond route used to return HTTP 400 "Session did not produce a question", which bounced
the client back to the already-answered view. Mirror Planning Mode's submitResponse contract:
return a successful { type:"question"|"complete" } payload (including the just-answered question
on generation failure) so SSE-driven retry remains the recovery path instead of a 400.
*/
export type AgentOnboardingRespondResult =
  | { type: "question"; data: PlanningQuestion }
  | { type: "complete"; data: AgentOnboardingSummary };

export async function respondToAgentOnboarding(
  sessionId: string,
  responses: Record<string, unknown>,
): Promise<AgentOnboardingRespondResult> {
  const session = sessions.get(sessionId);
  if (!session) throw new SessionNotFoundError(`Agent onboarding session ${sessionId} not found or expired`);
  if (!session.currentQuestion) throw new InvalidSessionStateError("No active question in session");
  const answeredQuestion = session.currentQuestion;
  session.history.push({ question: answeredQuestion, response: responses });
  /*
  FNXC:PlanningRetry 2026-07-14-00:00:
  Same invariant as Planning Mode: once an answer is accepted the session is no longer awaiting
  input, so clear currentQuestion before generating. This stops the onboarding SSE catch-up from
  re-emitting the answered question to fresh connections and stops retry from prompting the agent
  to "continue from" a question the user already answered.

  FNXC:AgentOnboarding 2026-07-14-18:20:
  answeredQuestion is retained for the generation-error 200 body below; currentQuestion stays
  cleared so SSE catch-up never re-emits the answered question while the modal retries via SSE.
  */
  session.currentQuestion = undefined;
  const formatted = `Question: ${answeredQuestion.question}\nAnswer: ${JSON.stringify(responses)}`;
  await continueConversation(session, formatted);

  if (session.summary) {
    return { type: "complete", data: session.summary };
  }
  if (session.currentQuestion) {
    return { type: "question", data: session.currentQuestion };
  }
  // Generation failed after the answer was accepted (session.error set + broadcast via SSE).
  // Preserve the successful respond contract like Planning Mode; do not throw 400.
  if (session.error && answeredQuestion) {
    return { type: "question", data: answeredQuestion };
  }
  throw new InvalidSessionStateError("AI agent did not return a question or summary");
}

export async function retryAgentOnboardingSession(sessionId: string, store?: TaskStore): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new SessionNotFoundError(`Agent onboarding session ${sessionId} not found or expired`);
  if (!session.error) throw new InvalidSessionStateError("Session is not in an error state");
  session.error = undefined;
  if (!session.agent) {
    session.agent = await createAgentOnboardingAgent(session, store);
  }
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
