// @vitest-environment node

/*
FNXC:PlanningTurnAdmission 2026-07-22-21:00:
Regression tests for the single-turn admission invariant. Reported bug: leaving and
re-entering Planning Mode mid-generation (every app-tab switch unmounts the view) raced a
second turn entry against the in-flight one; the loser displaced the winner and disposed the
session-shared agent mid-prompt, surfacing "AI returned no valid JSON" and visibly duplicated
generations. The invariant: at most one turn per session is ever admitted, across ALL entry
points (submitResponse, retrySession, startExistingSession/initial turn), and the losing entry
is rejected or ignored without touching the winner's agent.
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
  createSessionWithAgent,
  GenerationInProgressError,
  getSession,
  planningStreamManager,
  retrySession,
  rewindSession,
  setAiSessionStore,
  startExistingSession,
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

interface ScriptedAgent {
  agent: { session: { state: { messages: Array<{ role: string; content: string }> }; prompt: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } };
  holdNextPrompt: () => void;
  releasePrompt: () => void;
  setResponder: (fn: () => string) => void;
}

function createScriptedAgent(): ScriptedAgent {
  const messages: Array<{ role: string; content: string }> = [];
  let gate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;
  let responder: () => string = () => QUESTION_JSON;

  const prompt = vi.fn(async () => {
    if (gate) {
      const pending = gate;
      gate = null;
      await pending;
    }
    messages.push({ role: "assistant", content: responder() });
  });

  return {
    agent: { session: { state: { messages }, prompt, dispose: vi.fn() } },
    holdNextPrompt: () => {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    },
    releasePrompt: () => {
      releaseGate?.();
      releaseGate = null;
    },
    setResponder: (fn: () => string) => {
      responder = fn;
    },
  };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

async function startSessionAwaitingInput(scripted: ScriptedAgent): Promise<string> {
  __setCreateFnAgent(vi.fn(async () => scripted.agent) as never);
  const sessionId = await createSessionWithAgent(
    "10.0.9.9",
    "Plan something small",
    "/tmp/project",
    MOCK_TASK_STORE,
  );
  planningStreamManager.consumeInitialTurn(sessionId)?.();
  await waitFor(async () => Boolean((await getSession(sessionId))?.currentQuestion));
  return sessionId;
}

describe("planning single-turn admission", () => {
  let storeGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetPlanningState();
    storeGet = vi.fn(async () => null);
    setAiSessionStore(Object.assign(new EventEmitter(), {
      upsert: vi.fn(async () => {}),
      get: storeGet,
      updateThinking: vi.fn(),
    }) as never);
  });

  it("rejects a concurrent submitResponse instead of displacing the in-flight turn", async () => {
    const scripted = createScriptedAgent();
    const sessionId = await startSessionAwaitingInput(scripted);
    const question = (await getSession(sessionId))!.currentQuestion!;

    scripted.holdNextPrompt();
    const first = submitResponse(sessionId, { [question.id]: "option-1" });
    const second = submitResponse(sessionId, { [question.id]: "option-2" });

    const [firstResult, secondResult] = await Promise.allSettled([
      first,
      second.finally(() => scripted.releasePrompt()),
    ]);
    scripted.releasePrompt();

    expect(secondResult.status).toBe("rejected");
    expect((secondResult as PromiseRejectedResult).reason).toBeInstanceOf(GenerationInProgressError);

    // The admitted turn must complete cleanly: its agent was never disposed mid-prompt and
    // it produced the next question rather than "AI returned no valid JSON".
    expect(firstResult.status).toBe("fulfilled");
    expect((firstResult as PromiseFulfilledResult<{ type: string }>).value.type).toBe("question");
    const session = await getSession(sessionId);
    expect(session?.error).toBeUndefined();
    expect(session?.currentQuestion).toBeDefined();
    expect(scripted.agent.session.dispose).not.toHaveBeenCalled();
  });

  it("admits exactly one of two racing retries", async () => {
    const scripted = createScriptedAgent();
    const sessionId = await startSessionAwaitingInput(scripted);
    const session = (await getSession(sessionId))!;
    session.error = "AI returned no valid JSON. Retry this planning session or start a new one.";
    // Both retries must pass the persisted error-state check so the synchronous turn
    // reservation — not the winner's error-clearing side effect — is what rejects the loser.
    storeGet.mockImplementation(async () => ({ id: sessionId, type: "planning", status: "error" }));

    const results = await Promise.allSettled([
      retrySession(sessionId, "/tmp/project", undefined, MOCK_TASK_STORE),
      retrySession(sessionId, "/tmp/project", undefined, MOCK_TASK_STORE),
    ]);

    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(GenerationInProgressError);

    const after = await getSession(sessionId);
    expect(after?.error).toBeUndefined();
    expect(after?.currentQuestion).toBeDefined();
  });

  it("treats a duplicate start of a generating session as a no-op", async () => {
    const scripted = createScriptedAgent();
    __setCreateFnAgent(vi.fn(async () => scripted.agent) as never);

    scripted.holdNextPrompt();
    const sessionId = await createSessionWithAgent(
      "10.0.9.9",
      "Plan something small",
      "/tmp/project",
      MOCK_TASK_STORE,
    );
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await waitFor(() => scripted.agent.session.prompt.mock.calls.length > 0);

    // A remounted client re-issuing start-streaming must not displace the live generation.
    await startExistingSession(sessionId, "/tmp/project", MOCK_TASK_STORE);
    expect(planningStreamManager.hasPendingInitialTurn(sessionId)).toBe(false);
    expect(scripted.agent.session.dispose).not.toHaveBeenCalled();

    scripted.releasePrompt();
    await waitFor(async () => Boolean((await getSession(sessionId))?.currentQuestion));
    const session = await getSession(sessionId);
    expect(session?.error).toBeUndefined();
    expect(scripted.agent.session.dispose).not.toHaveBeenCalled();
  });

  it("resolves two concurrent duplicate starts without an initial-turn registration error", async () => {
    const scripted = createScriptedAgent();
    __setCreateFnAgent(vi.fn(async () => scripted.agent) as never);

    scripted.holdNextPrompt();
    const sessionId = await createSessionWithAgent(
      "10.0.9.9",
      "Plan something small",
      "/tmp/project",
      MOCK_TASK_STORE,
    );
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await waitFor(() => scripted.agent.session.prompt.mock.calls.length > 0);

    // FNXC:PlanningTurnAdmission 2026-07-23-10:10:
    // Two racing duplicate starts must BOTH be quiet no-ops — the pre-fix code let the
    // second reach registerInitialTurn and throw "Initial planning turn already registered".
    const results = await Promise.allSettled([
      startExistingSession(sessionId, "/tmp/project", MOCK_TASK_STORE),
      startExistingSession(sessionId, "/tmp/project", MOCK_TASK_STORE),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(planningStreamManager.hasPendingInitialTurn(sessionId)).toBe(false);

    scripted.releasePrompt();
    await waitFor(async () => Boolean((await getSession(sessionId))?.currentQuestion));
    expect((await getSession(sessionId))?.error).toBeUndefined();
  });

  it("rewind waits for the cancelled turn to release before mutating state", async () => {
    const scripted = createScriptedAgent();
    const sessionId = await startSessionAwaitingInput(scripted);
    const question = (await getSession(sessionId))!.currentQuestion!;

    scripted.holdNextPrompt();
    const submit = submitResponse(sessionId, { [question.id]: "option-1" });
    await waitFor(() => scripted.agent.session.prompt.mock.calls.length > 1);

    /*
    FNXC:PlanningTurnAdmission 2026-07-23-10:10:
    Rewind aborts the in-flight turn, waits for its owner to release the turn slot AND for
    the cancelled operation (the held provider prompt) to settle, then republishes the
    answered question as awaiting input. The prompt is released after rewind starts so the
    settle-wait resolves deterministically; awaiting `submit` afterwards proves the cancelled
    turn's post-prompt abort checks bail out without corrupting the rewound state.
    */
    const rewindPromise = rewindSession(sessionId, undefined, "/tmp/project", undefined, MOCK_TASK_STORE);
    scripted.releasePrompt();
    const rewound = await rewindPromise;
    expect(rewound.currentQuestion.id).toBe(question.id);

    await submit;

    const session = await getSession(sessionId);
    expect(session?.currentQuestion?.id).toBe(question.id);
    expect(session?.error).toBeUndefined();
  });

  it("ignores late streaming callbacks from a disposed agent after rewind", async () => {
    /*
    FNXC:PlanningTurnAdmission 2026-07-23-10:40:
    A provider that ignores cancellation beyond rewind's bounded settle-wait can keep
    streaming into its onThinking/onText callbacks after the agent was disposed. Those late
    deltas must be inert — no thinkingOutput mutation, no broadcast — or they would corrupt
    the state published after the rewound question (PR #2417 review finding).
    */
    const scripted = createScriptedAgent();
    const capturedOnThinking: Array<(delta: string) => void> = [];
    __setCreateFnAgent(vi.fn(async (options: { onThinking?: (delta: string) => void }) => {
      if (options?.onThinking) capturedOnThinking.push(options.onThinking);
      return scripted.agent;
    }) as never);

    const sessionId = await createSessionWithAgent(
      "10.0.9.9",
      "Plan something small",
      "/tmp/project",
      MOCK_TASK_STORE,
    );
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await waitFor(async () => Boolean((await getSession(sessionId))?.currentQuestion));
    const question = (await getSession(sessionId))!.currentQuestion!;

    scripted.holdNextPrompt();
    const submit = submitResponse(sessionId, { [question.id]: "option-1" });
    await waitFor(() => scripted.agent.session.prompt.mock.calls.length > 1);

    const rewindPromise = rewindSession(sessionId, undefined, "/tmp/project", undefined, MOCK_TASK_STORE);
    scripted.releasePrompt();
    await rewindPromise;
    await submit;

    // The first (disposed) agent's streaming callback fires late — it must be a no-op.
    const staleEvents: unknown[] = [];
    const unsubscribe = planningStreamManager.subscribe(sessionId, (event) => staleEvents.push(event));
    expect(capturedOnThinking.length).toBeGreaterThan(0);
    capturedOnThinking[0]("stale delta after dispose");
    unsubscribe();

    const session = await getSession(sessionId);
    expect(session?.thinkingOutput).toBe("");
    expect(staleEvents).toHaveLength(0);
  });

  it("emits the retryable parse error without a doubled period", async () => {
    const scripted = createScriptedAgent();
    const sessionId = await startSessionAwaitingInput(scripted);
    const question = (await getSession(sessionId))!.currentQuestion!;

    // Both the original turn and the single reformat retry return JSON-free prose.
    scripted.setResponder(() => "je ne peux pas produire de JSON ici");
    await submitResponse(sessionId, { [question.id]: "option-1" });

    const session = await getSession(sessionId);
    expect(session?.error).toBe(
      "AI returned no valid JSON. Retry this planning session or start a new one.",
    );
    expect(session?.error).not.toContain("..");
  });
});
