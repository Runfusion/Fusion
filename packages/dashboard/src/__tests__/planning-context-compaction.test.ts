// @vitest-environment node

/*
FNXC:PlanningContextCompaction 2026-07-22-22:40:
Planning prompts must route through the engine's promptWithFallback so context-window
overflows recover via compaction instead of surfacing "prompt is too long" as a terminal
session error (whose auto-retry replays the FULL history and overflows again). These tests
pin the invariant: when the engine exposes promptWithFallback, every planning agent prompt —
initial turn, answer turns, reformat retries — goes through it, with the generation
AbortSignal forwarded; and a context-limit error recovered inside promptWithFallback leaves
the planning turn healthy.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { TaskStore } from "@fusion/core";

const promptWithFallbackCalls: Array<{ prompt: string; options?: { signal?: AbortSignal } }> = [];
let simulateContextRecoveryOnce = false;

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  resolveMcpServersForStore: async () => ({ servers: [] }),
  buildSessionSkillContextSync: () => ({
    skillSelectionContext: undefined,
    resolvedSkillNames: ["fusion"],
    skillSource: "role-fallback" as const,
  }),
  createFnAgent: vi.fn(),
  createWorkflowAuthoringTools: () => [],
  createChatTaskDocumentTools: () => [],
  createChatTaskLogsReadTool: () => ({}),
  promptWithFallback: vi.fn(async (
    agentSession: { prompt: (input: string, options?: { signal?: AbortSignal }) => Promise<void> },
    prompt: string,
    options?: { signal?: AbortSignal },
  ) => {
    promptWithFallbackCalls.push({ prompt, options });
    if (simulateContextRecoveryOnce) {
      // Mirror the engine contract: the raw prompt overflows, compaction recovers,
      // and the retried prompt succeeds — the caller sees one successful await.
      simulateContextRecoveryOnce = false;
      try {
        throw new Error("prompt is too long: 210000 tokens > 200000 maximum");
      } catch {
        // compacted; fall through to the retried prompt below
      }
    }
    await agentSession.prompt(prompt, options);
  }),
}));

import {
  __resetPlanningState,
  __setCreateFnAgent,
  createSessionWithAgent,
  getSession,
  planningStreamManager,
  setAiSessionStore,
  submitResponse,
} from "../planning.js";

const MOCK_TASK_STORE = {
  listTasks: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({})),
  getTask: vi.fn(async () => {
    throw new Error("not found");
  }),
} as unknown as TaskStore;

const QUESTION_JSON = JSON.stringify({
  type: "question",
  data: { id: "q-next", type: "single_select", question: "What next?" },
});

function createFakeAgent() {
  const messages: Array<{ role: string; content: string }> = [];
  const prompt = vi.fn(async () => {
    messages.push({ role: "assistant", content: QUESTION_JSON });
  });
  return { session: { state: { messages }, prompt, dispose: vi.fn() } };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

describe("planning context-window compaction routing", () => {
  beforeEach(() => {
    __resetPlanningState();
    promptWithFallbackCalls.length = 0;
    simulateContextRecoveryOnce = false;
    setAiSessionStore(Object.assign(new EventEmitter(), {
      upsert: vi.fn(async () => {}),
      get: vi.fn(async () => null),
      updateThinking: vi.fn(),
    }) as never);
  });

  it("routes every planning prompt through promptWithFallback and forwards the abort signal", async () => {
    const agent = createFakeAgent();
    __setCreateFnAgent(vi.fn(async () => agent) as never);

    const sessionId = await createSessionWithAgent(
      "10.0.7.7",
      "Plan a long feature",
      "/tmp/project",
      MOCK_TASK_STORE,
    );
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await waitFor(async () => Boolean((await getSession(sessionId))?.currentQuestion));

    expect(promptWithFallbackCalls.length).toBeGreaterThan(0);
    const initialCall = promptWithFallbackCalls[0];
    expect(initialCall.options?.signal).toBeInstanceOf(AbortSignal);

    const question = (await getSession(sessionId))!.currentQuestion!;
    const beforeTurn = promptWithFallbackCalls.length;
    await submitResponse(sessionId, { [question.id]: "option-1" });

    // The answer turn also went through the context-limit-aware path, signal included.
    expect(promptWithFallbackCalls.length).toBeGreaterThan(beforeTurn);
    const turnCall = promptWithFallbackCalls[beforeTurn];
    expect(turnCall.options?.signal).toBeInstanceOf(AbortSignal);
    // Planning never bypasses the wrapper: every raw prompt was issued by the wrapper itself.
    expect(agent.session.prompt).toHaveBeenCalledTimes(promptWithFallbackCalls.length);
  });

  it("keeps the turn healthy when promptWithFallback recovers from a context overflow", async () => {
    const agent = createFakeAgent();
    __setCreateFnAgent(vi.fn(async () => agent) as never);

    const sessionId = await createSessionWithAgent(
      "10.0.7.7",
      "Plan a long feature",
      "/tmp/project",
      MOCK_TASK_STORE,
    );
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await waitFor(async () => Boolean((await getSession(sessionId))?.currentQuestion));

    const question = (await getSession(sessionId))!.currentQuestion!;
    simulateContextRecoveryOnce = true;
    const response = await submitResponse(sessionId, { [question.id]: "option-1" });

    expect(response.type).toBe("question");
    const session = await getSession(sessionId);
    expect(session?.error).toBeUndefined();
    expect(session?.currentQuestion).toBeDefined();
  });
});
