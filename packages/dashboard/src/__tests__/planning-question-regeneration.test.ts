// @vitest-environment node

/*
FNXC:PlanningQuestionRegeneration 2026-07-23-21:40:
Regression tests for the reported dead-end: refining a plan (or submitting any input) while
the session had no active question — e.g. after a failed retry cleared summary/currentQuestion
— surfaced "No active question in session" to the operator. Requirement: never surface that
error for a live session; instead reprompt the agent to continue the interview and generate a
fresh option-driven question from the accumulated context.

## Symptom Verification
- Original symptom: Refine on a plan with no active question returned 400
  InvalidSessionStateError("No active question in session").
- Exact reproduction: submitResponse with {refine:true} (and with a plain answer) on a session
  whose summary/currentQuestion are cleared.
- Assertion it is gone: submitResponse resolves with a regenerated type:"question" response,
  session.error stays unset, and no "No active question" error is thrown.
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
  data: { id: "q-regenerated", type: "single_select", question: "Which direction next?" },
});

function createScriptedAgent() {
  const messages: Array<{ role: string; content: string }> = [];
  const prompt = vi.fn(async (..._args: unknown[]) => {
    messages.push({ role: "assistant", content: QUESTION_JSON });
  });
  return { agent: { session: { state: { messages }, prompt, dispose: vi.fn() } }, prompt };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

async function startSessionAwaitingInput(ip: string) {
  const scripted = createScriptedAgent();
  __setCreateFnAgent(vi.fn(async () => scripted.agent) as never);
  const sessionId = await createSessionWithAgent(ip, "Plan something small", "/tmp/project", MOCK_TASK_STORE);
  planningStreamManager.consumeInitialTurn(sessionId)?.();
  await waitFor(async () => Boolean((await getSession(sessionId))?.currentQuestion));
  return { sessionId, scripted };
}

describe("planning question regeneration instead of no-active-question errors", () => {
  beforeEach(() => {
    __resetPlanningState();
    setAiSessionStore(Object.assign(new EventEmitter(), {
      upsert: vi.fn(async () => {}),
      get: vi.fn(async () => null),
      updateThinking: vi.fn(),
    }) as never);
  });

  it("refine with no summary and no active question regenerates a question", async () => {
    const { sessionId } = await startSessionAwaitingInput("10.2.0.1");
    const session = (await getSession(sessionId))!;
    // A retry that failed mid-regeneration leaves the session in exactly this shape.
    session.summary = undefined;
    session.currentQuestion = undefined;

    const result = await submitResponse(sessionId, { refine: true, focus: "tighten scope" }, "/tmp/project", undefined, MOCK_TASK_STORE);

    expect(result.type).toBe("question");
    const after = (await getSession(sessionId))!;
    expect(after.error).toBeUndefined();
    expect(after.currentQuestion).toBeDefined();
  });

  it("a plain submission with no active question reprompts for a fresh question instead of throwing", async () => {
    const { sessionId, scripted } = await startSessionAwaitingInput("10.2.0.2");
    const session = (await getSession(sessionId))!;
    session.currentQuestion = undefined;
    const historyLengthBefore = session.history.length;

    const result = await submitResponse(sessionId, { "q-stale": "my answer" }, "/tmp/project", undefined, MOCK_TASK_STORE);

    expect(result.type).toBe("question");
    const after = (await getSession(sessionId))!;
    expect(after.error).toBeUndefined();
    expect(after.currentQuestion?.id).toBe("q-regenerated");
    // No history entry is fabricated — there was no question to pair the response with.
    expect(after.history.length).toBe(historyLengthBefore);
    // The reprompt instructs the agent to continue the interview and carries the operator input.
    const lastPrompt = scripted.prompt.mock.calls[scripted.prompt.mock.calls.length - 1]?.[0] as string;
    expect(lastPrompt).toContain("no active interview question");
    expect(lastPrompt).toContain("my answer");
  });

  /*
  FNXC:PlanningReopenAfterValidate 2026-07-23-23:30:
  Validation must not freeze the plan: a new turn (refine/comments/answers) on a validated
  session reopens it and continues the interview instead of throwing "already been validated".
  */
  it("reopens a validated session when a refine turn arrives", async () => {
    const { sessionId } = await startSessionAwaitingInput("10.2.0.9");
    const session = (await getSession(sessionId))!;
    session.validated = true;
    session.currentQuestion = undefined;

    const result = await submitResponse(sessionId, { refine: true, focus: "add rollout plan" }, "/tmp/project", undefined, MOCK_TASK_STORE);

    expect(result.type).toBe("question");
    expect(session.validated).toBe(false);
    expect(session.error).toBeUndefined();
    expect(session.currentQuestion).toBeDefined();
  });

  it("contextual comments with no summary still apply via the rebuilt running summary", async () => {
    const { sessionId } = await startSessionAwaitingInput("10.2.0.3");
    const session = (await getSession(sessionId))!;
    session.summary = undefined;
    session.currentQuestion = undefined;

    const result = await submitResponse(
      sessionId,
      { contextualComments: [{ quote: "the plan", suggestion: "make it smaller" }] },
      "/tmp/project",
      undefined,
      MOCK_TASK_STORE,
    );

    expect(result.type).toBe("question");
    expect((await getSession(sessionId))!.error).toBeUndefined();
  });
});
