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
  createTaskFromPlanSession,
  getSession,
  InvalidSessionStateError,
  planningProposalClaimId,
  planningStreamManager,
  rewindSession,
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

  /*
  FNXC:PlanningMultiTask 2026-07-24-00:20:
  One plan can produce multiple tasks. Editing a plan whose current epoch already created a
  task rotates the creation epoch (new proposalClaimId key, claim state reset, task recorded
  in createdTaskIds) so the next Proceed creates a fresh task; a session without a created
  task keeps its epoch so unedited Proceed replays stay idempotent.
  */
  it("rotates the task-creation epoch when a task-linked plan is edited", async () => {
    const { sessionId } = await startSessionAwaitingInput("10.2.0.10");
    const session = (await getSession(sessionId))!;
    session.validated = true;
    session.createdTaskId = "FN-100";
    session.createClaimStatus = "created";
    session.currentQuestion = undefined;

    expect(planningProposalClaimId(sessionId, session.taskCreationEpoch)).toBe(`planning-session:${sessionId}`);

    const result = await submitResponse(sessionId, { refine: true }, "/tmp/project", undefined, MOCK_TASK_STORE);

    expect(result.type).toBe("question");
    expect(session.taskCreationEpoch).toBe(1);
    expect(session.createdTaskId).toBeUndefined();
    expect(session.createClaimStatus).toBe("none");
    expect(session.createdTaskIds).toEqual(["FN-100"]);
    expect(planningProposalClaimId(sessionId, session.taskCreationEpoch)).toBe(`planning-session:${sessionId}#1`);

    // A second edit without a new created task must NOT rotate again.
    const secondResult = await submitResponse(sessionId, { refine: true, focus: "smaller scope" }, "/tmp/project", undefined, MOCK_TASK_STORE);
    expect(secondResult.type).toBe("question");
    expect(session.taskCreationEpoch).toBe(1);
    expect(session.createdTaskIds).toEqual(["FN-100"]);
  });

  /*
  FNXC:PlanningMultiTask 2026-07-24-01:40:
  Review findings: (a) rewindSession shares the rotation invariant with submitResponse and
  needs its own regression coverage; (b) a REJECTED request must never burn a phantom
  rotation — reopen/rotation only run after admission and preconditions pass.
  */
  it("rotates the epoch when rewinding an answered question on a task-linked plan", async () => {
    const { sessionId } = await startSessionAwaitingInput("10.2.0.11");
    const session = (await getSession(sessionId))!;
    const question = session.currentQuestion!;
    await submitResponse(sessionId, { [question.id]: "first answer" }, "/tmp/project", undefined, MOCK_TASK_STORE);
    expect(session.history.length).toBeGreaterThan(0);

    session.validated = true;
    session.createdTaskId = "FN-200";
    session.createClaimStatus = "created";

    await rewindSession(sessionId, undefined, "/tmp/project", undefined, MOCK_TASK_STORE);

    expect(session.taskCreationEpoch).toBe(1);
    expect(session.createdTaskIds).toEqual(["FN-200"]);
    expect(session.createdTaskId).toBeUndefined();
    expect(session.createClaimStatus).toBe("none");
    expect(session.validated).toBe(false);
  });

  it("does not rotate the epoch when a rewind is rejected before admission", async () => {
    const { sessionId } = await startSessionAwaitingInput("10.2.0.12");
    const session = (await getSession(sessionId))!;
    // Live task-linked session with NO history: rewind must reject without touching claim state.
    session.validated = true;
    session.createdTaskId = "FN-300";
    session.createClaimStatus = "created";
    session.history = [];

    await expect(rewindSession(sessionId, undefined, "/tmp/project", undefined, MOCK_TASK_STORE))
      .rejects.toBeInstanceOf(InvalidSessionStateError);

    expect(session.taskCreationEpoch).toBeUndefined();
    expect(session.createdTaskId).toBe("FN-300");
    expect(session.createClaimStatus).toBe("created");
    expect(session.validated).toBe(true);
  });

  /*
  FNXC:PlanningMultiTask 2026-07-24-02:30:
  Agent-surface twin of the create-task route: createTaskFromPlanSession must be claim-aware
  (proposalClaimId recorded on the task), idempotent on replay, and epoch-aware after the plan
  is edited past a created task (review finding: the CLI previously bypassed all of this).
  */
  it("createTaskFromPlanSession is claim-aware, idempotent on replay, and epoch-aware after edits", async () => {
    const { sessionId } = await startSessionAwaitingInput("10.2.0.13");

    const tasks: Array<{ id: string; title: string; description: string; column: string; dependencies: string[]; proposalClaimId?: string }> = [];
    let taskSequence = 0;
    const createTask = vi.fn(async (input: { title: string; description: string; dependencies?: string[]; proposalClaimId?: string }) => {
      taskSequence += 1;
      const task = {
        id: `FN-CLI-${taskSequence}`,
        title: input.title,
        description: input.description,
        column: "triage",
        dependencies: input.dependencies ?? [],
        proposalClaimId: input.proposalClaimId,
      };
      tasks.push(task);
      return task;
    });
    const taskStore = {
      listTasks: vi.fn(async () => [...tasks]),
      getTask: vi.fn(async (id: string) => {
        const found = tasks.find((task) => task.id === id);
        if (found) return found;
        throw new Error("not found");
      }),
      createTask,
    } as unknown as TaskStore;

    const first = await createTaskFromPlanSession(sessionId, taskStore);
    expect(first.alreadyCreated).toBe(false);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0][0].proposalClaimId).toBe(`planning-session:${sessionId}`);
    expect((await getSession(sessionId))?.validated).toBe(true);

    const replay = await createTaskFromPlanSession(sessionId, taskStore);
    expect(replay.alreadyCreated).toBe(true);
    expect(replay.task.id).toBe(first.task.id);
    expect(createTask).toHaveBeenCalledTimes(1);

    // Editing the plan reopens the session and rotates the creation epoch.
    const refined = await submitResponse(sessionId, { refine: true, focus: "split rollout" }, "/tmp/project", undefined, MOCK_TASK_STORE);
    expect(refined.type).toBe("question");

    const second = await createTaskFromPlanSession(sessionId, taskStore);
    expect(second.alreadyCreated).toBe(false);
    expect(second.task.id).not.toBe(first.task.id);
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls[1][0].proposalClaimId).toBe(`planning-session:${sessionId}#1`);

    /*
    FNXC:PlanningMultiTask 2026-07-24-03:20:
    Reported bug: deleting the created task dead-ended the plan forever
    (PLANNING_CREATED_TASK_MISSING on every retry). A deleted linked task (absent from the
    include-archived scan) must clear the stale linkage and create a fresh task.
    */
    const deletedIndex = tasks.findIndex((task) => task.id === second.task.id);
    tasks.splice(deletedIndex, 1);
    const afterDeletion = await createTaskFromPlanSession(sessionId, taskStore);
    expect(afterDeletion.alreadyCreated).toBe(false);
    expect(afterDeletion.task.id).not.toBe(second.task.id);
    expect(createTask).toHaveBeenCalledTimes(3);
    // The replacement task reuses the current epoch's claim key (its unique-index row died with the deleted task).
    expect(createTask.mock.calls[2][0].proposalClaimId).toBe(`planning-session:${sessionId}#1`);
  });

  /*
  FNXC:PlanningMultiTask 2026-07-24-01:40:
  Durable round-trip of the new epoch fields through buildSessionFromRow's normalization
  (review finding: the positive-integer guard and string-array filter were untested).
  */
  it("restores and normalizes taskCreationEpoch/createdTaskIds from a persisted row", async () => {
    const baseRow = {
      type: "planning",
      status: "awaiting_input",
      title: "Restored plan",
      conversationHistory: "[]",
      currentQuestion: null,
      result: null,
      thinkingOutput: "",
      error: null,
      projectId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const rows: Record<string, unknown> = {
      "row-valid": {
        ...baseRow,
        id: "row-valid",
        inputPayload: JSON.stringify({ initialPlan: "Restore me", taskCreationEpoch: 2, createdTaskIds: ["FN-1", 42, "FN-2"] }),
      },
      "row-malformed": {
        ...baseRow,
        id: "row-malformed",
        inputPayload: JSON.stringify({ initialPlan: "Restore me", taskCreationEpoch: -3, createdTaskIds: "not-an-array" }),
      },
    };
    setAiSessionStore(Object.assign(new EventEmitter(), {
      upsert: vi.fn(async () => {}),
      get: vi.fn(async (id: string) => rows[id] ?? null),
      updateThinking: vi.fn(),
    }) as never);

    const valid = (await getSession("row-valid"))!;
    expect(valid.taskCreationEpoch).toBe(2);
    expect(valid.createdTaskIds).toEqual(["FN-1", "FN-2"]);

    const malformed = (await getSession("row-malformed"))!;
    expect(malformed.taskCreationEpoch).toBeUndefined();
    expect(malformed.createdTaskIds).toBeUndefined();
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
