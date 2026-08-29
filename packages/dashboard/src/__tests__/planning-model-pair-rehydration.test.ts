// @vitest-environment node

/*
FNXC:PlanningModelRehydration 2026-07-24-16:20:
Regression tests for the planning lane's provider/model pair.

Reported symptom: a planning interview streamed Q1 and Q2 normally on the operator's
configured (custom) provider, then a later turn died with
`401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`
from api.anthropic.com — a provider the operator never selected for planning. Every other
Fusion lane using the same model worked.

Cause: `ensureSessionAgent` rebuilt the agent with `undefined, undefined` for the model pair
(while still preserving draftThinkingLevel), and the non-streaming start never passed one at
all. With an incomplete pair the runtime forwards no `model`, so pi-coding-agent selects its
OWN built-in default (`anthropic/claude-opus-4-8`) — the resumed turn silently left the
operator's provider and hit Anthropic with a key they never configured.

Invariant asserted here across ALL rebuild/start surfaces, not just the reported one:
every planning agent construction receives a complete `defaultProvider`/`defaultModelId`
pair — the pair persisted on the draft when present, otherwise the lane's settings-resolved
pair — and planning is created through the shared runtime-resolving seam.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { TaskStore } from "@fusion/core";

const { createResolvedAgentSessionMock } = vi.hoisted(() => ({
  createResolvedAgentSessionMock: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  resolveMcpServersForStore: async () => ({ servers: [] }),
  buildSessionSkillContextSync: () => ({
    skillSelectionContext: undefined,
    resolvedSkillNames: ["fusion"],
    skillSource: "role-fallback" as const,
  }),
  createResolvedAgentSession: createResolvedAgentSessionMock,
  createWorkflowAuthoringTools: () => [],
  createChatTaskDocumentTools: () => [],
  createChatTaskLogsReadTool: () => ({}),
}));

import {
  __resetPlanningState,
  __setCreateFnAgent,
  createSession,
  createSessionWithAgent,
  getSession,
  planningStreamManager,
  retrySession,
  setAiSessionStore,
  submitResponse,
} from "../planning.js";

const SETTINGS_PAIR = { planningProvider: "acme-custom", planningModelId: "acme-large" };

function taskStore(settings: Record<string, unknown> = SETTINGS_PAIR): TaskStore {
  return {
    listTasks: vi.fn(async () => []),
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn(async () => {
      throw new Error("not found");
    }),
  } as unknown as TaskStore;
}

const QUESTION_JSON = JSON.stringify({
  type: "question",
  data: { id: "q-next", type: "single_select", question: "What next?" },
});

function scriptedAgent() {
  const messages: Array<{ role: string; content: string }> = [];
  return {
    session: {
      state: { messages },
      prompt: vi.fn(async () => {
        messages.push({ role: "assistant", content: QUESTION_JSON });
      }),
      dispose: vi.fn(),
    },
  };
}

function lastPair(factory: ReturnType<typeof vi.fn>): { provider?: string; model?: string } | undefined {
  const pairs = capturedPairs(factory);
  return pairs[pairs.length - 1];
}

async function waitFor(predicate: () => Promise<boolean> | boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

/** Every provider/model pair the planning lane handed to the session factory. */
function capturedPairs(factory: ReturnType<typeof vi.fn>): Array<{ provider?: string; model?: string }> {
  return factory.mock.calls.map(([options]) => ({
    provider: options?.defaultProvider,
    model: options?.defaultModelId,
  }));
}

describe("planning provider/model pair is never dropped", () => {
  let factory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetPlanningState();
    createResolvedAgentSessionMock.mockReset();
    setAiSessionStore(Object.assign(new EventEmitter(), {
      upsert: vi.fn(async () => {}),
      get: vi.fn(async () => null),
      updateThinking: vi.fn(),
    }) as never);
    factory = vi.fn(async () => scriptedAgent());
  });

  /*
  Ordered first deliberately: it exercises the module's DEFAULT session factory, which the
  `__setCreateFnAgent` seam in the later tests permanently replaces for this module instance.
  */
  it("creates planning sessions through the shared runtime-resolving seam", async () => {
    createResolvedAgentSessionMock.mockImplementation(async () => scriptedAgent());

    const sessionId = await createSessionWithAgent(
      "10.9.0.1",
      "Plan something small",
      "/tmp/project",
      taskStore(),
      "acme-custom",
      "acme-large",
    );
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await waitFor(async () => Boolean((await getSession(sessionId))?.currentQuestion));

    expect(createResolvedAgentSessionMock).toHaveBeenCalled();
    const [options] = createResolvedAgentSessionMock.mock.calls[0];
    // Runtime resolution is what lets a CLI/plugin runtime own its own auth instead of
    // forcing every planning turn onto a direct, key-requiring provider call.
    expect(options.sessionPurpose).toBe("executor");
    expect(options.defaultProvider).toBe("acme-custom");
    expect(options.defaultModelId).toBe("acme-large");
  });

  it("rebuilds a resumed agent on the pair the session started with (reported symptom)", async () => {
    __setCreateFnAgent(factory as never);
    const store = taskStore();
    const sessionId = await createSessionWithAgent(
      "10.9.0.2",
      "Plan something small",
      "/tmp/project",
      store,
      "acme-custom",
      "acme-large",
    );
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await waitFor(async () => Boolean((await getSession(sessionId))?.currentQuestion));

    const session = (await getSession(sessionId))!;
    const question = session.currentQuestion!;
    // Exactly the reported state: the in-memory agent is gone (restart / eviction /
    // draft resumed from History) and the next turn must rebuild it.
    session.agent = undefined;

    await submitResponse(sessionId, { [question.id]: "option-1" }, "/tmp/project", undefined, store);

    expect(factory.mock.calls.length).toBeGreaterThan(1);
    // The original failure: the rebuild call carried no pair at all, so the runtime fell
    // through to its built-in anthropic default and 401'd on a raw x-api-key.
    for (const pair of capturedPairs(factory)) {
      expect(pair).toEqual({ provider: "acme-custom", model: "acme-large" });
    }
  });

  it("falls back to the settings-resolved pair when the draft carries none", async () => {
    __setCreateFnAgent(factory as never);
    const store = taskStore();
    // No explicit pair on start — the draft has nothing to replay from.
    const sessionId = await createSessionWithAgent("10.9.0.3", "Plan something small", "/tmp/project", store);
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await waitFor(async () => Boolean((await getSession(sessionId))?.currentQuestion));

    const session = (await getSession(sessionId))!;
    const question = session.currentQuestion!;
    session.agent = undefined;
    session.draftModelProvider = undefined;
    session.draftModelId = undefined;

    await submitResponse(sessionId, { [question.id]: "option-1" }, "/tmp/project", undefined, store);

    const rebuild = lastPair(factory);
    expect(rebuild).toEqual({ provider: "acme-custom", model: "acme-large" });
  });

  it("keeps the pair on the retry rebuild surface", async () => {
    __setCreateFnAgent(factory as never);
    const store = taskStore();
    const sessionId = await createSessionWithAgent(
      "10.9.0.4",
      "Plan something small",
      "/tmp/project",
      store,
      "acme-custom",
      "acme-large",
    );
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await waitFor(async () => Boolean((await getSession(sessionId))?.currentQuestion));

    const session = (await getSession(sessionId))!;
    session.error = "AI returned no valid JSON. Retry this planning session or start a new one.";
    session.agent = undefined;

    await retrySession(sessionId, "/tmp/project", undefined, store);

    const rebuild = lastPair(factory);
    expect(rebuild).toEqual({ provider: "acme-custom", model: "acme-large" });
  });

  it("resolves a pair on the non-streaming start surface too", async () => {
    __setCreateFnAgent(factory as never);
    const store = taskStore();

    await createSession("10.9.0.5", "Plan something small", store, "/tmp/project");

    expect(capturedPairs(factory)[0]).toEqual({ provider: "acme-custom", model: "acme-large" });
  });

  it("still constructs an agent when no pair can be resolved anywhere", async () => {
    __setCreateFnAgent(factory as never);
    // Empty settings: no lane pair, no project default. The session must still start
    // (runtime built-in default) rather than throwing at the operator mid-interview.
    const store = taskStore({});

    await createSession("10.9.0.6", "Plan something small", store, "/tmp/project");

    expect(capturedPairs(factory)[0]).toEqual({ provider: undefined, model: undefined });
  });
});
