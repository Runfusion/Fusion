// @vitest-environment node

/*
FNXC:TaskDeleteAttribution 2026-07-26-17:30:
POST /api/subtasks/create-tasks closes (deletes) the parent task after a breakdown.
Invariants under test:
  - the parent delete is ATTRIBUTED via the task-delete-attribution vocabulary
    (auditContext with callerKind "engine" — automation behind the planning session,
    not an operator click);
  - a parent-delete failure is SURFACED, not swallowed: the response reports
    parentTaskClosed:false plus parentTaskCloseError, and runtimeLogger.warn fires so
    server diagnostics show the failure (the FN-2164 ghost-parent incident was a silent
    swallow here);
  - a successful delete reports parentTaskClosed:true.
In-memory store fakes and a mocked subtask-session module — no DB, AI, or timers.
*/

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

vi.mock("../../subtask-breakdown.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getSubtaskSession: vi.fn(async () => ({
      sessionId: "S1",
      initialDescription: "break down the parent",
    })),
    cleanupSubtaskSession: vi.fn(),
  };
});

vi.mock("@fusion/engine", async () => {
  const { createEngineMock } = await import("../../test/mockCoreEngine.js");
  return createEngineMock({
    createAgentTask: vi.fn(async (_store: unknown, input: { title: string }) => ({
      task: { id: "FN-100", title: input.title, column: "todo", steps: [] },
      wasDuplicate: false,
    })),
  });
});

import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import type { ServerOptions } from "../../server.js";
import { request as REQUEST } from "../../test-request.js";

function makeHarness(deleteImpl: () => Promise<void>) {
  const deleteSpy = vi.fn(deleteImpl);
  const warnSpy = vi.fn();
  const logger = {
    scope: "test",
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => logger,
  };

  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getSettings: vi.fn(async () => ({})),
    getTask: vi.fn(async () => { throw new Error("parent not found"); }),
    updateTask: vi.fn(async (id: string) => ({ id })),
    logEntry: vi.fn(async () => {}),
    deleteTask: deleteSpy,
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store, { runtimeLogger: logger } as unknown as ServerOptions));
  return { app, deleteSpy, warnSpy };
}

async function postCreateTasks(app: Parameters<typeof REQUEST>[0]) {
  return REQUEST(app, "POST", "/api/subtasks/create-tasks", JSON.stringify({
    sessionId: "S1",
    parentTaskId: "FN-1",
    subtasks: [{ tempId: "t1", title: "Child A", description: "first child" }],
  }), { "content-type": "application/json" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/subtasks/create-tasks — parent close attribution and failure surfacing", () => {
  it("attributes the parent delete with an engine auditContext", async () => {
    const { app, deleteSpy } = makeHarness(async () => {});
    const res = await postCreateTasks(app);

    expect(res.status).toBe(201);
    expect((res.body as { parentTaskClosed?: boolean }).parentTaskClosed).toBe(true);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    const [deletedId, options] = deleteSpy.mock.calls[0] as [string, { auditContext?: Record<string, unknown> }];
    expect(deletedId).toBe("FN-1");
    expect(options.auditContext).toMatchObject({
      agentId: "system",
      sessionId: "S1",
      callerKind: "engine",
    });
    expect(String(options.auditContext?.runId)).toContain("synthetic-planning-delete-FN-1");
  });

  it("surfaces a parent-delete failure in the response payload and warns in server diagnostics", async () => {
    const { app, warnSpy } = makeHarness(async () => {
      throw new Error("Cannot delete FN-1: live tasks still depend on it");
    });
    const res = await postCreateTasks(app);

    expect(res.status).toBe(201);
    const body = res.body as { parentTaskClosed?: boolean; parentTaskCloseError?: string };
    expect(body.parentTaskClosed).toBe(false);
    expect(body.parentTaskCloseError).toBe("Cannot delete FN-1: live tasks still depend on it");
    expect(warnSpy.mock.calls.some(([message, context]) =>
      String(message).includes("failed to close parent task")
      && (context as { parentTaskId?: string })?.parentTaskId === "FN-1",
    )).toBe(true);
  });
});
