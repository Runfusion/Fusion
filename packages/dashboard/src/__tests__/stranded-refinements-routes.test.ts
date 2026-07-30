// @vitest-environment node

import { describe, it, expect, vi } from "vitest";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskStore, TaskDetail } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    getRootDir: vi.fn().mockReturnValue(mkdtempSync(join(tmpdir(), "kb-stranded-route-"))),
    listStrandedRefinements: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    /*
    FNXC:PluginMcpServers 2026-07-24-02:05:
    FN-8491 (3cd023fa4) made resolveProjectContext bind a project-scoped plugin
    MCP provider on every getProjectContext call; a store exposing
    getProjectScopedPluginMcpServers is treated as runtime-owned and skips the
    binder (which would otherwise 500 on getPluginStore()).
    */
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as TaskStore;
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

async function REQUEST(app: express.Express, method: string, path: string) {
  return performRequest(app, method, path);
}

/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
`todo`, not `triage`. #2515 merged the default lineage's pre-implementation columns into
one whose id is `todo` (displayed "Planning") and REMOVED `triage` — so the default
workflow no longer declares `triage` at all, and these refine routes now correctly reject
a card sitting there. The fixture was a pre-merge artifact: it described a board shape the
product no longer ships.

Verified rather than assumed: `columnsWithFlag(resolveDefaultWorkflowIr(), "intake")` is
`["todo"]`, and the default's columns are `[todo, in-progress, in-review, done, archived]`.
That is why narrowing the routes' intake guards to the resolved column (dropping the
legacy `|| === "triage"` disjunct) surfaced these three, and why updating the fixture is
the correct resolution rather than re-widening the guard.
*/
const BASE_TASK: TaskDetail = {
  id: "FN-100",
  title: "refine",
  description: "refine",
  column: "todo",
  sourceType: "task_refine",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: new Date(Date.now() - 11 * 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
  prompt: "",
};

describe("stranded refinement routes", () => {
  it("GET /tasks/stranded-refinements returns list", async () => {
    const store = createMockStore({
      listStrandedRefinements: vi.fn().mockResolvedValue([{ task: BASE_TASK, reasons: ["untriaged-stale"], ageMs: 1000 }]),
    });
    const res = await REQUEST(createApp(store), "GET", "/api/tasks/stranded-refinements");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it("GET /tasks/stranded-refinements rejects invalid freshnessMinutes", async () => {
    const store = createMockStore();
    const res = await REQUEST(createApp(store), "GET", "/api/tasks/stranded-refinements?freshnessMinutes=0");
    expect(res.status).toBe(400);
  });

  it("POST /tasks/:id/expedite-refinement keeps awaiting-approval status", async () => {
    const task = { ...BASE_TASK, status: "awaiting-approval" as const };
    const store = createMockStore({ getTask: vi.fn().mockResolvedValue(task) });
    const res = await REQUEST(createApp(store), "POST", "/api/tasks/FN-100/expedite-refinement");
    expect(res.status).toBe(200);
    expect(res.body.expedited).toBe(false);
    expect(res.body.requiresOperatorAction).toBe("approve-plan");
    expect((store.updateTask as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("POST /tasks/:id/expedite-refinement clears recovery backoff", async () => {
    const task = { ...BASE_TASK, nextRecoveryAt: new Date(Date.now() + 60_000).toISOString() };
    const updated = { ...task, nextRecoveryAt: undefined };
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue(task),
      listStrandedRefinements: vi.fn().mockResolvedValue([{ task, reasons: ["recovery-backoff"], ageMs: 1000 }]),
      updateTask: vi.fn().mockResolvedValue(updated),
    });
    const res = await REQUEST(createApp(store), "POST", "/api/tasks/FN-100/expedite-refinement");
    expect(res.status).toBe(200);
    expect(res.body.expedited).toBe(true);
    // Echoes the fixture's column, which is now the merged planning column.
    expect(res.body.task.column).toBe("todo");
  });

  it("GET /tasks/:id/stranded-refinement returns detail", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "kb-stranded-detail-"));
    mkdirSync(join(rootDir, ".fusion", "tasks", "FN-100"), { recursive: true });
    writeFileSync(join(rootDir, ".fusion", "tasks", "FN-100", "PROMPT.md"), "# prompt\n");
    const store = createMockStore({
      getRootDir: vi.fn().mockReturnValue(rootDir),
      getTask: vi.fn().mockResolvedValue(BASE_TASK),
      listStrandedRefinements: vi.fn().mockResolvedValue([{ task: BASE_TASK, reasons: ["untriaged-stale"], ageMs: 1000 }]),
    });
    const res = await REQUEST(createApp(store), "GET", "/api/tasks/FN-100/stranded-refinement");
    expect(res.status).toBe(200);
    expect(res.body.promptExists).toBe(true);
  });
});
