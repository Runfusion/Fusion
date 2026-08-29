import { describe, expect, it, vi } from "vitest";
import { agentActionRoutes } from "../routes/agent-action-routes.js";

type FakeTask = {
  id: string;
  column: string;
  status?: string | null;
  description: string;
  title?: string;
  updatedAt: string;
  assigneeUserId?: string | null;
  assignedAgentId?: string | null;
  stuckKillCount?: number | null;
};

type Ctx = {
  pluginId: string;
  settings: { apiKey: string; enableAgentActions: boolean };
  taskStore: {
    getTask: ReturnType<typeof vi.fn>;
    moveTask: ReturnType<typeof vi.fn>;
    updateTask: ReturnType<typeof vi.fn>;
  };
  logger: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  moveTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
};

function makeTask(overrides: Partial<FakeTask> = {}): FakeTask {
  return {
    id: "FN-1",
    column: "todo",
    status: null,
    description: "task",
    title: "task",
    updatedAt: "2026-01-01T00:00:00.000Z",
    assigneeUserId: "u1",
    assignedAgentId: "a1",
    stuckKillCount: 0,
    ...overrides,
  };
}

function getRoute(path: string) {
  const route = agentActionRoutes.find((entry) => entry.method === "POST" && entry.path === path);
  if (!route) throw new Error(`missing route ${path}`);
  return route;
}

function createCtx(task: FakeTask, overrides: Partial<Ctx> = {}): Ctx {
  const state = { ...task };
  const getTask = vi.fn(async (id: string) => (id === state.id ? { ...state } : null));
  const moveTask = vi.fn(async (id: string, column: string) => {
    if (id !== state.id) throw new Error("boom");
    state.column = column;
  });
  const updateTask = vi.fn(async (id: string, updates: Record<string, unknown>) => {
    if (id !== state.id) throw new Error("boom");
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete (state as Record<string, unknown>)[key];
      else (state as Record<string, unknown>)[key] = value;
    }
  });

  const base: Ctx = {
    pluginId: "fusion-plugin-even-realities-glasses",
    settings: { apiKey: "secret", enableAgentActions: true },
    taskStore: { getTask, moveTask, updateTask },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    moveTask,
    updateTask,
  };

  return { ...base, ...overrides };
}

const CASES = [
  { verb: "start-work", path: "/actions/start-work", happyTask: makeTask({ column: "todo" }), badTask: makeTask({ column: "triage", status: "planning" }) },
  { verb: "request-review", path: "/actions/request-review", happyTask: makeTask({ column: "in-progress" }), badTask: makeTask({ column: "todo" }) },
  { verb: "approve-plan", path: "/actions/approve-plan", happyTask: makeTask({ column: "triage", status: "awaiting-approval" }), badTask: makeTask({ column: "triage", status: "planning" }) },
  { verb: "accept-review", path: "/actions/accept-review", happyTask: makeTask({ column: "in-review", status: "awaiting-user-review" }), badTask: makeTask({ column: "todo" }) },
  { verb: "return-to-agent", path: "/actions/return-to-agent", happyTask: makeTask({ column: "in-review", status: "failed" }), badTask: makeTask({ column: "todo" }) },
  { verb: "retry", path: "/actions/retry", happyTask: makeTask({ column: "todo", status: "failed" }), badTask: makeTask({ column: "in-progress", status: null }) },
] as const;

describe("agentActionRoutes", () => {
  it.each(CASES)("returns 401 for missing/wrong key ($verb)", async ({ path, happyTask }) => {
    const route = getRoute(path);
    const ctx = createCtx(happyTask);
    const missing = await route.handler({ body: { taskId: "FN-1" }, headers: {} } as never, ctx as never);
    const wrong = await route.handler({ body: { taskId: "FN-1" }, headers: { authorization: "Bearer bad" } } as never, ctx as never);
    expect(missing).toMatchObject({ status: 401 });
    expect(wrong).toMatchObject({ status: 401 });
  });

  it.each(CASES)("returns 403 when disabled ($verb)", async ({ path, happyTask }) => {
    const route = getRoute(path);
    const ctx = createCtx(happyTask, { settings: { apiKey: "secret", enableAgentActions: false } });
    const res = await route.handler({ body: { taskId: "FN-1" }, headers: { authorization: "Bearer secret" } } as never, ctx as never);
    expect(res).toMatchObject({ status: 403, body: { error: "agent actions are disabled" } });
    expect(ctx.moveTask).not.toHaveBeenCalled();
    expect(ctx.updateTask).not.toHaveBeenCalled();
  });

  it.each(CASES)("returns 400 for invalid taskId ($verb)", async ({ path, happyTask }) => {
    const route = getRoute(path);
    const ctx = createCtx(happyTask);
    const res = await route.handler({ body: { taskId: "   " }, headers: { authorization: "Bearer secret" } } as never, ctx as never);
    expect(res).toMatchObject({ status: 400, body: { error: "taskId is required" } });
  });

  it.each(CASES)("returns 404 for unknown task ($verb)", async ({ path, happyTask }) => {
    const route = getRoute(path);
    const ctx = createCtx(happyTask);
    const res = await route.handler({ body: { taskId: "FN-999" }, headers: { authorization: "Bearer secret" } } as never, ctx as never);
    expect(res).toMatchObject({ status: 404, body: { error: "task not found" } });
  });

  it.each(CASES)("returns 409 for precondition mismatch ($verb)", async ({ path, badTask }) => {
    const route = getRoute(path);
    const ctx = createCtx(badTask);
    const res = await route.handler({ body: { taskId: "FN-1" }, headers: { authorization: "Bearer secret" } } as never, ctx as never);
    expect(res).toMatchObject({ status: 409 });
    expect(ctx.moveTask).not.toHaveBeenCalled();
  });

  it.each(CASES)("returns 200 with task + card on success ($verb)", async ({ path, happyTask }) => {
    const route = getRoute(path);
    const ctx = createCtx(happyTask);
    const res = await route.handler({ body: { taskId: "FN-1" }, headers: { authorization: "Bearer secret" } } as never, ctx as never);
    expect(res).toMatchObject({ status: 200, body: { task: { id: "FN-1" }, card: { kind: "task" } } });
  });

  it.each(CASES)("returns 500 for unexpected store failure ($verb)", async ({ path, happyTask, verb }) => {
    const route = getRoute(path);
    const ctx = createCtx(happyTask, {
      taskStore: {
        getTask: vi.fn(async () => ({ ...happyTask })),
        moveTask: vi.fn(async () => {
          throw new Error("db down");
        }),
        updateTask: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
    } as Partial<Ctx>);

    const res = await route.handler({ body: { taskId: "FN-1" }, headers: { authorization: "Bearer secret" } } as never, ctx as never);
    expect(res).toMatchObject({ status: 500, body: { error: `${verb} failed` } });
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});
