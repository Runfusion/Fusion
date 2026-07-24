// @vitest-environment node

/*
FNXC:PlanningProviderErrors 2026-07-23-20:10:
Regression tests for provider-error handling in dedicated Planning Mode. Reported bug: a
provider failure (auth error, overloaded provider, model-registry stall) thrown between
persistSession("generating") and the turn's own error handling escaped to the route with the
session row left "generating" forever — no persisted error, no SSE error event, no watchdog —
so the Planning modal hung on "Thinking/Generating plan" (its SSE reconnect loop and 8s poll
both treat a persisted "generating" row as healthy). Invariant: once a planning session enters
"generating", every non-abort failure lands it in a retryable persisted "error" state with an
SSE error event, and a stream connect against a settled/stranded session terminates with an
error event instead of waiting forever.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { TaskStore } from "@fusion/core";

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
}));

import {
  __resetPlanningState,
  __setCreateFnAgent,
  createSession,
  createSessionWithAgent,
  getSession,
  PLANNING_INTERRUPTED_ERROR_MESSAGE,
  planningStreamManager,
  reconcileStalePlanningGeneration,
  retrySession,
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

const PROVIDER_ERROR_MESSAGE = "Provider rejected the request: 401 invalid_api_key";

function createScriptedAgent(responder: () => string = () => QUESTION_JSON) {
  const messages: Array<{ role: string; content: string }> = [];
  const prompt = vi.fn(async () => {
    messages.push({ role: "assistant", content: responder() });
  });
  return { agent: { session: { state: { messages }, prompt, dispose: vi.fn() } } };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

async function startSessionAwaitingInput(ip: string): Promise<string> {
  const scripted = createScriptedAgent();
  __setCreateFnAgent(vi.fn(async () => scripted.agent) as never);
  const sessionId = await createSessionWithAgent(ip, "Plan something small", "/tmp/project", MOCK_TASK_STORE);
  planningStreamManager.consumeInitialTurn(sessionId)?.();
  await waitFor(async () => Boolean((await getSession(sessionId))?.currentQuestion));
  return sessionId;
}

function bufferedErrorEvents(sessionId: string): unknown[] {
  return planningStreamManager
    .getBufferedEvents(sessionId, 0)
    .filter((event: { event: string }) => event.event === "error");
}

describe("planning provider-error recovery", () => {
  let upsertMock: ReturnType<typeof vi.fn>;
  let storeGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetPlanningState();
    upsertMock = vi.fn(async () => {});
    storeGet = vi.fn(async () => null);
    setAiSessionStore(Object.assign(new EventEmitter(), {
      upsert: upsertMock,
      get: storeGet,
      updateThinking: vi.fn(),
    }) as never);
  });

  it("submitResponse persists a retryable error when agent rebuild hits a provider failure after entering generating", async () => {
    const sessionId = await startSessionAwaitingInput("10.1.0.1");
    const session = (await getSession(sessionId))!;
    const question = session.currentQuestion!;

    // Force the ensureSessionAgent path (agent gone, e.g. after retry disposal) with a provider failure.
    session.agent = undefined;
    __setCreateFnAgent(vi.fn(async () => {
      throw new Error(PROVIDER_ERROR_MESSAGE);
    }) as never);

    await expect(
      submitResponse(sessionId, { [question.id]: "option-1" }, "/tmp/project", undefined, MOCK_TASK_STORE),
    ).rejects.toThrow(PROVIDER_ERROR_MESSAGE);

    const after = (await getSession(sessionId))!;
    expect(after.error).toContain(PROVIDER_ERROR_MESSAGE);
    expect(bufferedErrorEvents(sessionId).length).toBeGreaterThan(0);
    await waitFor(() => upsertMock.mock.calls.some((call) => call[0]?.status === "error"));
  });

  it("retrySession re-persists an error instead of stranding the session in generating", async () => {
    const sessionId = await startSessionAwaitingInput("10.1.0.2");
    const session = (await getSession(sessionId))!;
    session.error = "AI returned no valid JSON. Retry this planning session or start a new one.";
    session.agent = undefined;
    storeGet.mockImplementation(async () => ({ id: sessionId, type: "planning", status: "error" }));

    __setCreateFnAgent(vi.fn(async () => {
      throw new Error(PROVIDER_ERROR_MESSAGE);
    }) as never);

    await expect(retrySession(sessionId, "/tmp/project", undefined, MOCK_TASK_STORE)).rejects.toThrow(PROVIDER_ERROR_MESSAGE);

    const after = (await getSession(sessionId))!;
    // retrySession clears the prior error before generating; the failure must restore a terminal error.
    expect(after.error).toContain(PROVIDER_ERROR_MESSAGE);
    await waitFor(() => upsertMock.mock.calls.some((call) => call[0]?.status === "error"));
  });

  it("legacy synchronous createSession persists an error when the provider fails before the first question", async () => {
    __setCreateFnAgent(vi.fn(async () => {
      throw new Error(PROVIDER_ERROR_MESSAGE);
    }) as never);

    await expect(
      createSession("10.1.0.3", "Plan something small", MOCK_TASK_STORE, "/tmp/project"),
    ).rejects.toThrow(PROVIDER_ERROR_MESSAGE);

    await waitFor(() => upsertMock.mock.calls.some((call) => call[0]?.status === "error"));
    const errorRows = upsertMock.mock.calls.map((call) => call[0]).filter((row: { status?: string }) => row?.status === "error");
    const errorRow = errorRows[errorRows.length - 1];
    expect(errorRow?.error).toContain(PROVIDER_ERROR_MESSAGE);
  });

  it("surfaces the provider failure from the reformat retry instead of a misleading parse error", async () => {
    const sessionId = await startSessionAwaitingInput("10.1.0.4");
    const session = (await getSession(sessionId))!;
    const question = session.currentQuestion!;

    let calls = 0;
    const scripted = createScriptedAgent(() => "definitely not json");
    scripted.agent.session.prompt = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        scripted.agent.session.state.messages.push({ role: "assistant", content: "definitely not json" });
        return;
      }
      throw new Error(PROVIDER_ERROR_MESSAGE);
    });
    session.agent = scripted.agent as never;

    await submitResponse(sessionId, { [question.id]: "option-1" }, "/tmp/project", undefined, MOCK_TASK_STORE);

    const after = (await getSession(sessionId))!;
    expect(after.error).toContain(PROVIDER_ERROR_MESSAGE);
  });

  describe("reconcileStalePlanningGeneration", () => {
    it("returns the persisted terminal error for a settled errored session", async () => {
      const sessionId = await startSessionAwaitingInput("10.1.0.5");
      const session = (await getSession(sessionId))!;
      session.error = PROVIDER_ERROR_MESSAGE;

      expect(reconcileStalePlanningGeneration(sessionId)).toBe(PROVIDER_ERROR_MESSAGE);
    });

    it("converts a stranded generating session past the watchdog window into a retryable error", async () => {
      const sessionId = await startSessionAwaitingInput("10.1.0.6");
      const session = (await getSession(sessionId))!;
      session.generationPurpose = "plan_update";
      session.generationStartedAt = new Date(Date.now() - 10 * 60_000).toISOString();

      expect(reconcileStalePlanningGeneration(sessionId)).toBe(PLANNING_INTERRUPTED_ERROR_MESSAGE);
      expect(session.error).toBe(PLANNING_INTERRUPTED_ERROR_MESSAGE);
      expect(bufferedErrorEvents(sessionId).length).toBeGreaterThan(0);
      await waitFor(() => upsertMock.mock.calls.some((call) => call[0]?.status === "error"));
    });

    it("leaves a fresh generating session alone", async () => {
      const sessionId = await startSessionAwaitingInput("10.1.0.7");
      const session = (await getSession(sessionId))!;
      session.generationPurpose = "plan_update";
      session.generationStartedAt = new Date().toISOString();

      expect(reconcileStalePlanningGeneration(sessionId)).toBeUndefined();
      expect(session.error).toBeUndefined();
    });

    it("leaves an awaiting-input session alone", async () => {
      const sessionId = await startSessionAwaitingInput("10.1.0.8");

      expect(reconcileStalePlanningGeneration(sessionId)).toBeUndefined();
      expect((await getSession(sessionId))!.error).toBeUndefined();
    });
  });
});
