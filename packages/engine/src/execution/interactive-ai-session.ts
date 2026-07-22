/**
 * Interactive AI session adapter (the U4 host seam).
 *
 * Builds a generic prompt → parse → retry → pause → resume loop on top of the
 * one-shot `createFnAgent`, modeled on `packages/dashboard/src/planning.ts`.
 * There is NO engine await-input primitive to call — this module IS that loop.
 *
 * Kept deliberately generic: it knows nothing about compound-engineering (or
 * any other application). The caller supplies a system prompt instructing the
 * agent to emit the JSON question/complete protocol; this module parses it and
 * surfaces structured events. To avoid leaking dashboard types into the seam,
 * the JSON parse/extract/repair helpers are reimplemented locally here rather
 * than imported from `@fusion/dashboard`.
 */

import type {
  CreateInteractiveAiSessionOptions,
  CreateInteractiveAiSessionResult,
  InteractiveAiSession,
  InteractiveAiSessionEvent,
  PlanningQuestion,
  PlanningResponse,
} from "@fusion/core";
import type { AgentRuntime } from "../agents/agent-runtime.js";
import { askAcpOnce } from "../cli-runtime/cli-agent-ask.js";

/** Minimal shape of an agent session we depend on (subset of pi's AgentSession). */
export interface InteractiveAgentSession {
  prompt(text: string): Promise<void>;
  state: {
    messages: Array<{
      role: string;
      content?: string | Array<{ type: string; text?: string; thinking?: string }>;
    }>;
  };
  dispose?: () => void | Promise<void>;
}

/** Minimal shape of an agent factory result. */
export interface InteractiveAgentResult {
  session: InteractiveAgentSession;
  sessionFile?: string;
}

/** Factory that creates the underlying one-shot agent (injectable for tests). */
export type InteractiveAgentFactory = (
  options: CreateInteractiveAiSessionOptions,
) => Promise<InteractiveAgentResult>;

/**
 * FNXC:PlanningExecutor 2026-06-19-01:45:
 * Planning now has one engine-local executor selector so callers can opt into the read-only CLI-agent/ACP path without changing core interactive-session options or the downstream PlanningResponse contract. The model executor remains the default selection.
 */
export type PlanningExecutorSelection =
  | { kind: "model" }
  | { kind: "cli-agent"; runtime: AgentRuntime };

/** One bounded reformat retry, matching planning.ts's MAX_PARSE_RETRIES. */
const MAX_PARSE_RETRIES = 1;

const REFORMAT_PROMPT =
  "Your previous response could not be parsed as JSON. " +
  'Please respond with ONLY a valid JSON object: {"type":"question","data":{...}} ' +
  'or {"type":"complete","data":{...}}. No markdown, no explanation, just the JSON.';

// ── Local JSON extraction/repair (reimplemented to keep core generic) ──────

function extractJsonCandidate(text: string): string | null {
  if (!text || !text.trim()) return null;

  // 1. Markdown code blocks first (most reliable).
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    const candidate = codeBlockMatch[1].trim();
    if (candidate.startsWith("{")) return candidate;
  }

  // 2. Balanced top-level brace objects.
  const candidates: Array<{ text: string }> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
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
        try {
          JSON.parse(candidate);
          candidates.push({ text: candidate });
        } catch {
          // not valid JSON, skip
        }
        break;
      }
    }
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.text.length - a.text.length);
    return candidates[0].text;
  }

  // 3. Last resort: full trimmed text.
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  return null;
}

function repairJson(text: string): string {
  let repaired = text.replace(/,\s*([}\]])/g, "$1");

  const count = (s: string): { braces: number; brackets: number; inString: boolean } => {
    let braces = 0;
    let brackets = 0;
    let inString = false;
    let escape = false;
    for (const ch of s) {
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
      if (ch === "{") braces++;
      if (ch === "}") braces--;
      if (ch === "[") brackets++;
      if (ch === "]") brackets--;
    }
    return { braces, brackets, inString };
  };

  if (count(repaired).inString) repaired += '"';
  const { braces, brackets } = count(repaired);
  repaired += "]".repeat(Math.max(0, brackets));
  repaired += "}".repeat(Math.max(0, braces));
  return repaired;
}

/** Parse agent output into a PlanningResponse; throws on unparseable/invalid. */
export function parseAgentResponse(text: string): PlanningResponse {
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    throw new Error("AI returned no valid JSON.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    try {
      parsed = JSON.parse(repairJson(candidate));
    } catch (repairErr) {
      throw new Error(
        `Failed to parse AI response: ${repairErr instanceof Error ? repairErr.message : "Unknown error"}.`,
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
    if (
      (typed.type === "question" || typed.type === "complete") &&
      typed.data !== null &&
      typed.data !== undefined
    ) {
      return parsed as PlanningResponse;
    }
  }
  throw new Error("AI returned an invalid response structure.");
}

/**
 * CLI-agent planning one-shot seam (U9).
 *
 * Runs a CLI-agent one-shot in `planning` purpose and maps its output into the
 * SAME `PlanningResponse` shape a model-backed planning run produces — so the
 * downstream planning flow cannot tell a CLI-backed run from a model run. The
 * one-shot runner is injected (`run`) so this is testable without a live PTY.
 *
 * The planning executor selector below is the production resolution point for
 * this seam: selecting `{ kind: "cli-agent" }` wraps this one-shot in the
 * `InteractiveAiSession` contract, while `{ kind: "model" }` keeps the existing
 * resumable model-backed loop. Threading a live CE `AgentRuntime` into the CE
 * orchestrator remains a gated Route-A follow-up and is intentionally out of
 * scope for this read-only planning path.
 */
export interface CliAgentPlanningOptions {
  prompt: string;
  cwd: string;
  settings?: { model?: string };
  systemPrompt?: string;
  timeoutMs?: number;
}

export async function runCliAgentPlanning(
  runtime: AgentRuntime,
  opts: CliAgentPlanningOptions,
): Promise<PlanningResponse> {
  const result = await askAcpOnce(runtime, {
    prompt: opts.prompt,
    cwd: opts.cwd,
    model: opts.settings?.model,
    systemPrompt: opts.systemPrompt,
    timeoutMs: opts.timeoutMs,
  });
  if (!result.ok) {
    throw new Error(`CLI-agent planning ACP ask failed (${result.reason}): ${result.message}`);
  }
  // Map to the planning flow's shape exactly as a model run would: parse the
  // ACP prose through the canonical planning parser.
  return parseAgentResponse(result.text);
}

/**
 * FNXC:PlanningExecutor 2026-06-19-01:45:
 * The CLI-agent planning executor is a read-only one-shot ACP ask adapted to the InteractiveAiSession interface. It emits exactly one terminal question/complete/error event; malformed or failed CLI-agent output must surface as error instead of fabricating a plan.
 *
 * Create an interactive-session facade over `runCliAgentPlanning`.
 *
 * The one-shot CLI-agent path produces a single terminal turn: even a
 * `question` event is terminal here and does not support multi-turn
 * question/answer. `runCliAgentPlanning` owns ACP session disposal via
 * `askAcpOnce`; this facade's dispose is therefore best-effort no-op.
 */
export async function createCliAgentPlanningSessionWith(
  runtime: AgentRuntime,
  options: CreateInteractiveAiSessionOptions,
): Promise<CreateInteractiveAiSessionResult> {
  let started = false;
  let terminalEvent: InteractiveAiSessionEvent | undefined;

  async function runOnce(text: string): Promise<InteractiveAiSessionEvent> {
    try {
      const response = await runCliAgentPlanning(runtime, {
        prompt: text,
        cwd: options.cwd,
        systemPrompt: options.systemPrompt,
        settings: options.defaultModelId ? { model: options.defaultModelId } : undefined,
      });
      terminalEvent = response.type === "question"
        ? { type: "question", data: response.data }
        : { type: "complete", data: response.data };
    } catch (err) {
      terminalEvent = {
        type: "error",
        data: { message: err instanceof Error ? err.message : String(err), cause: err },
      };
    }
    return terminalEvent;
  }

  const session: InteractiveAiSession = {
    async prompt(text: string): Promise<void> {
      if (terminalEvent || started) return;
      started = true;
      await runOnce(text);
    },

    async nextEvent(): Promise<InteractiveAiSessionEvent> {
      return terminalEvent ?? { type: "error", data: { message: "No turn in progress. Call prompt() first." } };
    },

    async answer(): Promise<void> {
      // Terminal one-shot facade: question events are not resumable here.
    },

    dispose(): void {
      // Best-effort no-op; askAcpOnce disposes the underlying ACP session.
    },
  };

  return { session };
}

/**
 * Resolve planning execution to either the default model-backed loop or the
 * selected CLI-agent/ACP one-shot adapter.
 */
export async function resolvePlanningExecutorSession(
  selection: PlanningExecutorSelection,
  modelFactory: InteractiveAgentFactory,
  options: CreateInteractiveAiSessionOptions,
): Promise<CreateInteractiveAiSessionResult> {
  if (selection.kind === "cli-agent") {
    return createCliAgentPlanningSessionWith(selection.runtime, options);
  }
  return createInteractiveAiSessionWith(modelFactory, options);
}

/** Extract text from the last assistant message (string | text blocks | thinking fallback). */
function extractLastAssistantText(session: InteractiveAgentSession): string {
  const lastMessage = session.state.messages.filter((m) => m.role === "assistant").pop();
  if (!lastMessage?.content) return "";
  if (typeof lastMessage.content === "string") return lastMessage.content;
  if (Array.isArray(lastMessage.content)) {
    const textContent = lastMessage.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");
    if (textContent) return textContent;
    // Fallback: thinking blocks when no text blocks present.
    return lastMessage.content
      .filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking" && typeof c.thinking === "string")
      .map((c) => c.thinking)
      .join("");
  }
  return "";
}

type LoopState = "idle" | "awaiting_input" | "complete" | "error";

/**
 * Build the interactive session over an injected agent factory.
 * Exported for direct (deterministic, fake-agent) testing.
 */
export async function createInteractiveAiSessionWith(
  agentFactory: InteractiveAgentFactory,
  options: CreateInteractiveAiSessionOptions,
): Promise<CreateInteractiveAiSessionResult> {
  const agentResult = await agentFactory(options);
  const agent = agentResult.session;

  let state: LoopState = "idle";
  let pendingEvent: Promise<InteractiveAiSessionEvent> | undefined;
  let terminalEvent: InteractiveAiSessionEvent | undefined;
  let currentQuestion: PlanningQuestion | undefined;
  let disposed = false;

  /**
   * Prompt the agent, read the last assistant message, parse it, and run one
   * bounded reformat retry. Returns the structured event for this turn.
   */
  async function runTurn(text: string): Promise<InteractiveAiSessionEvent> {
    if (disposed) {
      return { type: "error", data: { message: "Session disposed." } };
    }
    try {
      await agent.prompt(text);
    } catch (err) {
      state = "error";
      const ev: InteractiveAiSessionEvent = {
        type: "error",
        data: { message: err instanceof Error ? err.message : String(err), cause: err },
      };
      terminalEvent = ev;
      return ev;
    }

    let responseText = extractLastAssistantText(agent);
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
            await agent.prompt(REFORMAT_PROMPT);
            responseText = extractLastAssistantText(agent);
          } catch (promptErr) {
            lastError = promptErr instanceof Error ? promptErr : new Error(String(promptErr));
            break;
          }
        }
      }
    }

    if (!parsed) {
      state = "error";
      const ev: InteractiveAiSessionEvent = {
        type: "error",
        data: { message: `Failed to parse agent response: ${lastError?.message ?? "Unknown error"}`, cause: lastError },
      };
      terminalEvent = ev;
      return ev;
    }

    if (parsed.type === "question") {
      currentQuestion = parsed.data;
      state = "awaiting_input";
      return { type: "question", data: parsed.data };
    }

    // complete
    state = "complete";
    const ev: InteractiveAiSessionEvent = { type: "complete", data: parsed.data };
    terminalEvent = ev;
    return ev;
  }

  const session: InteractiveAiSession = {
    async prompt(text: string): Promise<void> {
      if (terminalEvent) return; // terminal: ignore further input
      pendingEvent = runTurn(text);
      // Surface prompt-time errors only via nextEvent(); never throw to caller.
      await pendingEvent.catch(() => undefined);
    },

    async nextEvent(): Promise<InteractiveAiSessionEvent> {
      if (terminalEvent) return terminalEvent;
      if (!pendingEvent) {
        return { type: "error", data: { message: "No turn in progress. Call prompt() or answer() first." } };
      }
      return pendingEvent;
    },

    async answer(questionId: string, response: unknown): Promise<void> {
      if (terminalEvent) return;
      if (state !== "awaiting_input") {
        pendingEvent = Promise.resolve<InteractiveAiSessionEvent>({
          type: "error",
          data: { message: "answer() called while not awaiting input." },
        });
        return;
      }
      if (currentQuestion && questionId !== currentQuestion.id && !options.allowAnswerQuestionIdDrift) {
        pendingEvent = Promise.resolve<InteractiveAiSessionEvent>({
          type: "error",
          data: { message: `answer() questionId "${questionId}" does not match current question "${currentQuestion.id}".` },
        });
        return;
      }
      const answerMessage = JSON.stringify({
        type: "answer",
        questionId,
        response,
      });
      currentQuestion = undefined;
      state = "idle";
      pendingEvent = runTurn(answerMessage);
      await pendingEvent.catch(() => undefined);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        void agent.dispose?.();
      } catch {
        // Best-effort cleanup; never throw from dispose.
      }
    },
  };

  return { session, sessionFile: agentResult.sessionFile };
}
