// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  resolveMcpServersForStore: async () => ({ servers: [] }),
  buildSessionSkillContextSync: () => ({ skillSelectionContext: undefined, resolvedSkillNames: [], skillSource: "role-fallback" as const }),
  createFnAgent: vi.fn(),
  createAgentTask: vi.fn(),
  createWorkflowAuthoringTools: () => [],
  createChatTaskDocumentTools: () => [],
  createChatTaskLogsReadTool: () => ({}),
}));

import { request as performRequest } from "../test-request.js";
import {
  __resetPlanningState,
  __setCreateFnAgent,
  getSession,
} from "../planning.js";
import { registerPlanningSubtaskRoutes } from "../routes/register-planning-subtask-routes.js";

/*
FNXC:PlanningMode 2026-07-30-12:00:
FN-8343 requires one deterministic route-and-engine test for the user-controlled Planning Mode lifecycle.
The scripted agent deliberately emits a legacy complete payload during the interview: it must be coerced into another question, while only the explicit validate route may finalize the running plan.
*/

type ApiResponse = { status: number; body: any };

async function post(app: express.Express, path: string, body: unknown): Promise<ApiResponse> {
  const response = await performRequest(
    app,
    "POST",
    path,
    JSON.stringify(body),
    { "Content-Type": "application/json" },
  );
  return { status: response.status, body: response.body };
}

async function get(app: express.Express, path: string): Promise<ApiResponse> {
  const response = await performRequest(app, "GET", path);
  return { status: response.status, body: response.body };
}

function question(id: string, prompt: string, language: "en" | "es" = "en") {
  const spanish = language === "es";
  return JSON.stringify({
    type: "question",
    data: {
      id,
      type: "single_select",
      question: prompt,
      options: [
        {
          id: `${id}-deliberate`,
          label: spanish ? "Implementación gradual" : "Deliberate rollout",
          pros: [spanish ? "Reduce el riesgo" : "Reduces risk"],
          cons: [spanish ? "Requiere más coordinación" : "Needs coordination"],
        },
        {
          id: `${id}-fast`,
          label: spanish ? "Entrega rápida" : "Fast delivery",
          pros: [spanish ? "Aporta valor antes" : "Delivers value sooner"],
          cons: [spanish ? "Aumenta el riesgo" : "Increases risk"],
        },
        { id: "other", label: spanish ? "Otro (escribe tu respuesta)" : "Other (write your own)", isOther: true },
      ],
    },
  });
}

function installContextAwareAgent() {
  const prompts: string[] = [];
  let completeResponseCount = 0;
  const messages: Array<{ role: string; content: string }> = [];
  const mockAgent = {
    session: {
      state: { messages },
      prompt: vi.fn(async (message: string) => {
        prompts.push(message);
        messages.push({ role: "user", content: message });

        let response: string;
        if (/Quiero crear/i.test(message)) {
          response = question("alcance", "¿Qué resultado necesita primero?", "es");
        } else if (prompts.length === 1) {
          response = question("scope", "Which outcome matters most?");
        } else if (/priorizar controles de privacidad/i.test(message)) {
          response = question("privacidad", "¿Qué controles de privacidad deben verificarse?", "en");
        } else if (/An earlier answer was edited/i.test(message)) {
          response = question("riesgo-reeditado", "¿Qué riesgo queda después de cambiar el alcance?");
        } else if (/Selected:\s*secure\b/i.test(message)) {
          // Adversarial legacy output: reactive Planning Mode must not terminate here.
          completeResponseCount += 1;
          response = JSON.stringify({ type: "complete", data: { title: "Premature plan", description: "Must not finalize" } });
        } else {
          response = question(`turn-${prompts.length}`, "Which delivery constraint matters next?");
        }
        messages.push({ role: "assistant", content: response });
      }),
      dispose: vi.fn(),
    },
  };
  __setCreateFnAgent(async () => mockAgent as never);
  return { prompts, mockAgent, getCompleteResponseCount: () => completeResponseCount };
}

function createStore() {
  /*
  FNXC:PlanningMultiTask 2026-07-24-01:40:
  Tasks record their proposalClaimId and stay listed so findCreatedTask's epoch-keyed
  crash-window reconciliation is exercised for real (review finding: only epoch 0 was
  covered). `tasks` is exposed so tests can inject an orphaned row simulating a crash
  between task insert and session finalize.
  */
  const tasks: Array<{ id: string; title: string; description: string; proposalClaimId?: string }> = [];
  const createTask = vi.fn(async (input: { title: string; description: string; proposalClaimId?: string }) => {
    const created = {
      id: `FN-E2E-00${tasks.length + 1}`,
      title: input.title,
      description: input.description,
      proposalClaimId: input.proposalClaimId,
    };
    tasks.push(created);
    return created;
  });
  return {
    getSettings: vi.fn().mockResolvedValue({
      autoMerge: false,
      agentClarificationEnabled: false,
      ntfyEnabled: false,
    }),
    getRootDir: vi.fn().mockReturnValue("/tmp/planning-e2e"),
    listTasks: vi.fn(async () => [...tasks]),
    getTask: vi.fn(async (id: string) => {
      const found = tasks.find((task) => task.id === id);
      if (found) return found;
      throw new Error("not found");
    }),
    createTask,
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    tasks,
  } as unknown as TaskStore & { createTask: typeof createTask; tasks: typeof tasks };
}

function buildApp(store: TaskStore): express.Express {
  const app = express();
  const router = express.Router();
  app.use(express.json());
  registerPlanningSubtaskRoutes({
    router,
    getProjectContext: async () => ({
      store,
      projectId: "planning-e2e-project",
      engine: { getMessageStore: () => ({}) },
    }),
    planningLogger: { warn: vi.fn() },
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never, {
    store,
    parseLastEventId: () => undefined,
    replayBufferedSSE: () => true,
  });
  app.use("/api", router);
  app.use((error: { status?: number; statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? error.status ?? 500).json({ error: error.message });
  });
  return app;
}

function expectRunningPlan(body: any) {
  expect(body.summary).toEqual(expect.objectContaining({
    title: expect.any(String),
    description: expect.any(String),
    keyDeliverables: expect.any(Array),
  }));
  expect(body.summary.description).not.toBe(body.firstQuestion?.question);
  expect(body.summary.keyDeliverables).not.toContain(body.firstQuestion?.question);
  expect(body.validated).toBe(false);
}

function expectOpenQuestion(body: any) {
  expect(body).toMatchObject({ type: "question", data: { id: expect.any(String) } });
  expect(body.data.id).not.toBe("complete");
  expect(body.data.id).not.toBe("planning-deepen-checkpoint");
}

/*
FNXC:PlanningMode 2026-07-30-14:20:
The synchronous respond route intentionally returns only the next question. The SSE snapshot is
therefore the route-visible running-plan contract for every interview turn; do not replace these
assertions with internal session-state checks, which would miss a client-facing regression.
*/
async function getRunningPlan(app: express.Express, sessionId: string) {
  const stream = await get(app, `/api/planning/${sessionId}/stream`);
  expect(stream.status).toBe(200);
  expect(typeof stream.body).toBe("string");
  const match = stream.body.match(/event: summary\ndata: (.+)\n/);
  expect(match?.[1]).toBeDefined();
  return JSON.parse(match![1]);
}

describe("Planning Mode plan creation E2E", () => {
  let store: ReturnType<typeof createStore>;
  let app: express.Express;
  let prompts: string[];
  let getCompleteResponseCount: () => number;

  beforeEach(() => {
    __resetPlanningState();
    store = createStore();
    app = buildApp(store);
    ({ prompts, getCompleteResponseCount } = installContextAwareAgent());
  });

  afterEach(() => {
    __resetPlanningState();
    __setCreateFnAgent(undefined as never);
  });

  it("converts the lean running plan into a task without a separate validation step", async () => {
    const start = await post(app, "/api/planning/start", { initialPlan: "Build secure account recovery" });
    expect(start.status).toBe(201);
    expectRunningPlan(start.body);
    const sessionId = start.body.sessionId as string;

    const created = await post(app, "/api/planning/create-task", { sessionId });
    expect(created).toMatchObject({ status: 201, body: { task: { id: "FN-E2E-001", title: "Plan: Build secure account recovery" }, alreadyCreated: false } });
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining("## Key deliverables"),
    }));
    expect((await getSession(sessionId))?.createdTaskId).toBe("FN-E2E-001");

    const retry = await post(app, "/api/planning/create-task", { sessionId });
    expect(retry).toMatchObject({ status: 200, body: { task: { id: "FN-E2E-001" }, alreadyCreated: true } });
    expect(store.createTask).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:PlanningMultiTask 2026-07-24-00:20:
  One plan can produce multiple tasks. Editing the plan after a task exists rotates the
  creation epoch: the next Proceed creates a FRESH task under a new epoch-suffixed
  proposalClaimId instead of replaying the first task, while unedited replays (above) stay
  idempotent within their epoch.
  */
  it("creates a second task after the plan is edited past the first one", async () => {
    const start = await post(app, "/api/planning/start", { initialPlan: "Build secure account recovery" });
    expect(start.status).toBe(201);
    const sessionId = start.body.sessionId as string;

    const created = await post(app, "/api/planning/create-task", { sessionId });
    expect(created.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledTimes(1);
    expect(store.createTask.mock.calls[0][0]).toMatchObject({ proposalClaimId: `planning-session:${sessionId}` });

    // Editing the validated plan reopens it and rotates the creation epoch.
    const refined = await post(app, "/api/planning/respond", { sessionId, responses: { refine: true, focus: "split rollout" } });
    expect(refined.status).toBe(200);
    const session = await getSession(sessionId);
    expect(session?.taskCreationEpoch).toBe(1);
    expect(session?.createdTaskIds).toEqual(["FN-E2E-001"]);

    const second = await post(app, "/api/planning/create-task", { sessionId });
    expect(second.status).toBe(201);
    expect(second.body.alreadyCreated).toBe(false);
    expect(store.createTask).toHaveBeenCalledTimes(2);
    expect(store.createTask.mock.calls[1][0]).toMatchObject({ proposalClaimId: `planning-session:${sessionId}#1` });

    /*
    FNXC:PlanningMultiTask 2026-07-24-01:40:
    Replay idempotency must hold INSIDE a rotated epoch too (review finding: only epoch 0's
    replay was pinned): an unedited Proceed after the second create returns that same task.
    */
    const replayAfterRotation = await post(app, "/api/planning/create-task", { sessionId });
    expect(replayAfterRotation.status).toBe(200);
    expect(replayAfterRotation.body.alreadyCreated).toBe(true);
    expect(replayAfterRotation.body.task.id).toBe("FN-E2E-002");
    expect(store.createTask).toHaveBeenCalledTimes(2);
  });

  /*
  FNXC:PlanningMultiTask 2026-07-24-01:40:
  Crash-after-insert recovery inside a ROTATED epoch: a task row exists under the epoch-1
  claim key but the session linkage was never finalized. Proceed must reconcile that row via
  findCreatedTask on the current epoch key instead of inserting a duplicate (review finding:
  the crash-window regression test only covered the un-suffixed epoch-0 key).
  */
  it("reconciles a crash-orphaned task row under an epoch-suffixed claim key instead of duplicating it", async () => {
    const start = await post(app, "/api/planning/start", { initialPlan: "Build secure account recovery" });
    expect(start.status).toBe(201);
    const sessionId = start.body.sessionId as string;

    const created = await post(app, "/api/planning/create-task", { sessionId });
    expect(created.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledTimes(1);

    const refined = await post(app, "/api/planning/respond", { sessionId, responses: { refine: true, focus: "split rollout" } });
    expect(refined.status).toBe(200);
    expect((await getSession(sessionId))?.taskCreationEpoch).toBe(1);

    // Simulate the crash window: the epoch-1 task row landed, but finalize never ran.
    store.tasks.push({
      id: "FN-E2E-CRASH",
      title: "Crash-orphaned second task",
      description: "inserted before finalize",
      proposalClaimId: `planning-session:${sessionId}#1`,
    });

    const retry = await post(app, "/api/planning/create-task", { sessionId });
    expect(retry.status).toBe(200);
    expect(retry.body.alreadyCreated).toBe(true);
    expect(retry.body.task.id).toBe("FN-E2E-CRASH");
    expect(store.createTask).toHaveBeenCalledTimes(1);
  });

  it("keeps AI-authored options and Other in the input language", async () => {
    const start = await post(app, "/api/planning/start", { initialPlan: "Quiero crear una recuperación segura de cuentas" });
    expect(start.status).toBe(201);
    expect(start.body.firstQuestion.question).toContain("resultado");
    expect(start.body.firstQuestion.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Implementación gradual" }),
      expect.objectContaining({ label: "Otro (escribe tu respuesta)", isOther: true }),
    ]));
    expectRunningPlan(start.body);
  });
});
