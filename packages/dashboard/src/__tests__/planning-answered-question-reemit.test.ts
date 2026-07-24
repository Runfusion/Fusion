// @vitest-environment node

/*
FNXC:PlanningRetry 2026-07-14-00:00:
Regression tests for the reported retry/regenerate loop: after the user answered a planning
question, session.currentQuestion kept the answered question through the next generation, the
SSE stream route's catch-up path re-emitted it to every fresh connection (each FN-7946
auto-retry opens one), and the client's question handler reset the bounded auto-retry budget —
an unbounded loop. Invariant under test: currentQuestion is only set while the session is
genuinely awaiting user input — cleared on answer accept, on retry, and never restored from
non-awaiting_input persisted rows.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { TaskStore } from "@fusion/core";
import { PLANNING_DEEPEN_CHECKPOINT_ID } from "@fusion/core";

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

import type { AiSessionRow, AiSessionStore } from "../ai-session-store.js";
import {
  __resetPlanningState,
  __setCreateFnAgent,
  createSessionWithAgent,
  GenerationInProgressError,
  getSession,
  planningStreamManager,
  retrySession,
  setAiSessionStore,
  submitResponse,
} from "../planning.js";

/*
FNXC:PlanningTurnAdmission 2026-07-24-01:25:
PR #2417 gave every planning generation entry point a synchronous single-turn reservation
that is held for the FULL span of the turn — including persistence work after
session.currentQuestion is emitted. The mock agent's microtask-based firstQuestionEmitted
signal therefore fires while the initial turn still holds the reservation, so an immediate
submitResponse/retrySession is (correctly) rejected with GenerationInProgressError.
Admission rejections are side-effect free by contract (the admission guards run before any
session mutation), so polling until admission succeeds is safe and deterministic.
*/
async function onceAdmitted<T>(attempt: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof GenerationInProgressError && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      throw err;
    }
  }
}

const MOCK_TASK_STORE = {
  /*
  FNXC:PlanningMode 2026-07-24-01:25:
  FN-8538 (3f976e3dc) gave Planning Mode a dedicated collaborative prompt:
  resolvePlanningModeSystemPrompt now reads store.getSettings() on every planning
  agent creation, so the mock store must expose it.
  */
  getSettings: vi.fn(async () => ({})),
  listTasks: vi.fn(async () => []),
  getTask: vi.fn(async () => {
    throw new Error("not found");
  }),
} as unknown as TaskStore;

const Q1 = { id: "q1", type: "text", question: "What should the plan prioritize first?" } as const;
const Q2 = { id: "q2", type: "text", question: "Any constraints to respect?" } as const;

function questionPayload(question: { id: string; type: string; question: string }): string {
  return JSON.stringify({ type: "question", data: question });
}

const COMPLETE_PAYLOAD = JSON.stringify({
  type: "complete",
  data: {
    title: "Plan title",
    description: "Plan description",
    suggestedSize: "M",
    keyDeliverables: ["deliverable"],
  },
});

type TurnBehavior =
  | { kind: "respond"; payload: string }
  | { kind: "reject"; error: Error }
  | { kind: "hang" };

/*
FNXC:PlanningRetry 2026-07-14-18:20:
Repo test policy forbids real polling loops (5ms timers) in unit tests. setupAgent exposes
deterministic promises for "first question emitted" and "hung turn entered" so callers await
agent seams instead of wall-clock polls.
*/
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Fake agent whose Nth prompt call follows the Nth behavior. Hung turns are
 * released via the returned controls so tests can assert mid-generation state.
 */
function setupAgent(behaviors: TurnBehavior[]) {
  const messages: Array<{ role: string; content: string }> = [];
  const promptCalls: string[] = [];
  let releaseHungTurn: ((payload: string) => void) | undefined;
  let firstQuestionEmitted = deferred<void>();
  let firstQuestionSignaled = false;
  let hungTurnEntered = deferred<void>();

  __setCreateFnAgent(vi.fn(async () => ({
    session: {
      state: { messages },
      prompt: vi.fn(async (message: string) => {
        const behavior = behaviors[promptCalls.length] ?? behaviors[behaviors.length - 1];
        promptCalls.push(message);
        if (behavior.kind === "reject") {
          throw behavior.error;
        }
        if (behavior.kind === "hang") {
          // Capture/resolve the "entered" signal before parking so callers that
          // grabbed hungTurnEntered before submit never race a replaced promise.
          const entered = hungTurnEntered;
          hungTurnEntered = deferred<void>();
          const payload = await new Promise<string>((resolve) => {
            releaseHungTurn = resolve;
            entered.resolve();
          });
          messages.push({ role: "assistant", content: payload });
          return;
        }
        messages.push({ role: "assistant", content: behavior.payload });
        if (!firstQuestionSignaled) {
          firstQuestionSignaled = true;
          // Resolve after continueAgentConversation finishes its post-prompt sync
          // work (parse + set currentQuestion) on the next microtask turn.
          queueMicrotask(() => {
            queueMicrotask(() => firstQuestionEmitted.resolve());
          });
        }
      }),
      dispose: vi.fn(),
    },
  })) as never);

  return {
    promptCalls,
    /** Resolves once the first respond turn has produced a session.currentQuestion. */
    firstQuestionEmitted: firstQuestionEmitted.promise,
    /**
     * Promise for the next hung turn entering. Capture before triggering the
     * hang-producing call (submit/retry), then await.
     */
    get hungTurnEntered() {
      return hungTurnEntered.promise;
    },
    releaseHungTurn: (payload: string) => {
      if (!releaseHungTurn) throw new Error("no hung turn to release");
      releaseHungTurn(payload);
      releaseHungTurn = undefined;
    },
  };
}

async function startSessionAtFirstQuestion(
  agent: ReturnType<typeof setupAgent>,
): Promise<string> {
  /*
  FNXC:PlanningRetry 2026-07-18-12:20:
  createSessionWithAgent defaults clarificationEnabled=false, which suppresses the first
  question into continueToSummaryAfterSuppressedQuestion and consumes the next mock prompt
  turn (often the hung turn these re-emit tests need). Opt into clarification so the
  multi-question interview invariants under test still run.
  */
  const sessionId = await createSessionWithAgent(
    "10.0.2.20",
    "Plan a feature",
    "/tmp/project",
    MOCK_TASK_STORE,
    undefined,
    undefined,
    undefined,
    { clarificationEnabled: true },
  );
  planningStreamManager.consumeInitialTurn(sessionId)?.();
  await agent.firstQuestionEmitted;
  const session = await getSession(sessionId);
  if (!session?.currentQuestion) {
    throw new Error("first question never arrived");
  }
  return sessionId;
}

describe("answered planning questions are never re-emittable", () => {
  beforeEach(() => {
    __resetPlanningState();
  });

  it("clears currentQuestion the moment an answer is accepted, for the whole next generation", async () => {
    const agent = setupAgent([
      { kind: "respond", payload: questionPayload(Q1) },
      { kind: "hang" },
    ]);
    const sessionId = await startSessionAtFirstQuestion(agent);

    const hungEntered = agent.hungTurnEntered;
    const submitPromise = onceAdmitted(() => submitResponse(sessionId, { q1: "ship auth first" }, "/tmp/project", undefined, MOCK_TASK_STORE));
    submitPromise.catch(() => {});
    await hungEntered;

    // The regression: this used to still be Q1 while generating, and the SSE
    // stream route's catch-up emit hands currentQuestion to fresh connections.
    const midGeneration = await getSession(sessionId);
    expect(midGeneration?.currentQuestion).toBeUndefined();
    expect(midGeneration?.history).toHaveLength(1);

    agent.releaseHungTurn(questionPayload(Q2));
    const result = await submitPromise;
    expect(result).toMatchObject({ type: "question", data: { id: Q2.id, question: Q2.question } });
    expect((await getSession(sessionId))?.currentQuestion).toMatchObject({ id: Q2.id, question: Q2.question });
  });

  it("keeps currentQuestion cleared when generation fails, while preserving the legacy 200 respond contract", async () => {
    const agent = setupAgent([
      { kind: "respond", payload: questionPayload(Q1) },
      { kind: "reject", error: new Error("provider exploded") },
    ]);
    const sessionId = await startSessionAtFirstQuestion(agent);

    const result = await onceAdmitted(() => submitResponse(sessionId, { q1: "ship auth first" }, "/tmp/project", undefined, MOCK_TASK_STORE));

    // The modal ignores this body and lets the SSE error event drive recovery;
    // it must stay a resolved response, not a thrown InvalidSessionStateError.
    expect(result).toMatchObject({ type: "question", data: { id: Q1.id, question: Q1.question } });

    const session = await getSession(sessionId);
    expect(session?.error).toMatch(/provider exploded/);
    expect(session?.currentQuestion).toBeUndefined();
  });

  it("retrySession scrubs a stale answered question before regenerating (pre-fix persisted rows)", async () => {
    const agent = setupAgent([
      { kind: "respond", payload: questionPayload(Q1) },
      { kind: "reject", error: new Error("provider exploded") },
      { kind: "hang" },
    ]);
    const sessionId = await startSessionAtFirstQuestion(agent);
    await onceAdmitted(() => submitResponse(sessionId, { q1: "ship auth first" }, "/tmp/project", undefined, MOCK_TASK_STORE));

    // Simulate a row persisted by a pre-fix build where the answered question lingered.
    const session = await getSession(sessionId);
    session!.currentQuestion = Q1;

    const hungEntered = agent.hungTurnEntered;
    const retryPromise = onceAdmitted(() => retrySession(sessionId, "/tmp/project", undefined, MOCK_TASK_STORE));
    retryPromise.catch(() => {});
    await hungEntered;

    expect((await getSession(sessionId))?.currentQuestion).toBeUndefined();

    agent.releaseHungTurn(questionPayload(Q2));
    await retryPromise;
    expect((await getSession(sessionId))?.currentQuestion).toMatchObject({ id: Q2.id, question: Q2.question });
  });

  /* FNXC:PlanningMode 2026-07-19-01:45: deepen checkpoint reemit case removed with FN-8341. */


  it("does not restore currentQuestion from persisted rows that are not awaiting input", async () => {
    const baseRow: Omit<AiSessionRow, "id" | "status"> = {
      type: "planning",
      title: "Restored session",
      inputPayload: JSON.stringify({ ip: "10.0.2.20", initialPlan: "Plan a feature" }),
      conversationHistory: JSON.stringify([{ question: Q1, response: { q1: "answered" }, thinkingOutput: "" }]),
      currentQuestion: JSON.stringify(Q1),
      result: null,
      thinkingOutput: "",
      error: "AI generation appears stuck with no new output.",
      projectId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const rows = new Map<string, AiSessionRow>([
      ["restored-error", { ...baseRow, id: "restored-error", status: "error" }],
      ["restored-generating", { ...baseRow, id: "restored-generating", status: "generating", error: null }],
      ["restored-awaiting", { ...baseRow, id: "restored-awaiting", status: "awaiting_input", error: null }],
    ]);

    const fakeStore = Object.assign(new EventEmitter(), {
      get: vi.fn(async (id: string) => rows.get(id) ?? null),
      upsert: vi.fn(async () => {}),
    }) as unknown as AiSessionStore;
    setAiSessionStore(fakeStore);

    expect((await getSession("restored-error"))?.currentQuestion).toBeUndefined();
    expect((await getSession("restored-generating"))?.currentQuestion).toBeUndefined();
    expect((await getSession("restored-awaiting"))?.currentQuestion).toMatchObject({ id: Q1.id, question: Q1.question });
  });
});
