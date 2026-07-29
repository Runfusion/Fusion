// @vitest-environment node
/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — P0, post-#2515):
Plan approve/reject must resolve the workflow's INTAKE column, not the id `triage`.

THE STALL THIS PINS. #2515 removed `triage` from the default lineage: there is now one
pre-implementation column, id `todo`, displayed as "Planning". The routes guarded with
`if (task.column !== "triage") throw badRequest(...)`, so after that merge the condition
was TRUE for every default-workflow card and BOTH routes rejected all of them. A card
parked `awaiting-approval` could be neither approved nor rejected — stuck, with no
operator action able to release it, and nothing crashing to reveal it.

That is the inverse of the usual drift: the guard did not stop firing, it started firing
on everything.

REVERT CHECK: restore either `task.column !== "triage"` literal and the matching case
fails with 400 instead of succeeding, because these cards are in `todo`.
*/
import { describe, it, expect, vi } from "vitest";
import express from "express";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskStore, TaskDetail } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

/** The post-#2515 default lineage: ONE pre-implementation column, id `todo`. */
const MERGED_CODING_IR = {
  version: "v2",
  name: "builtin-stepwise-coding",
  columns: [
    { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [{ id: "start", kind: "start", column: "todo" }, { id: "end", kind: "end", column: "done" }],
  edges: [{ from: "start", to: "end" }],
};

/** A card parked awaiting approval on the merged planning column. */
const PLANNING_TASK: TaskDetail = {
  id: "FN-200",
  title: "awaiting approval",
  description: "",
  column: "todo",
  status: "awaiting-approval",
  sourceType: "task_refine",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  prompt: "# Plan",
} as unknown as TaskDetail;

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    getRootDir: vi.fn().mockReturnValue(mkdtempSync(join(tmpdir(), "kb-plan-approval-"))),
    getTask: vi.fn().mockResolvedValue(PLANNING_TASK),
    updateTask: vi.fn().mockResolvedValue(PLANNING_TASK),
    moveTask: vi.fn().mockResolvedValue(PLANNING_TASK),
    logEntry: vi.fn().mockResolvedValue(undefined),
    // Resolve the merged workflow so the routes see its real intake column.
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "builtin:stepwise-coding" }),
    getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "builtin:stepwise-coding", name: "Coding", ir: MERGED_CODING_IR }),
    listWorkflowDefinitions: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    off: vi.fn(),
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

describe("plan approval on the merged planning column (post-#2515)", () => {
  it("does NOT reject approve-plan for a card in the merged intake column", async () => {
    const res = await performRequest(createApp(createMockStore()), "POST", "/api/tasks/FN-200/approve-plan");
    // The specific failure this exists to catch: a 400 whose message names a column that
    // no longer exists in the default lineage.
    expect(res.status).not.toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/must be in 'triage'/i);
  });

  it("does NOT reject reject-plan for a card in the merged intake column", async () => {
    const res = await performRequest(createApp(createMockStore()), "POST", "/api/tasks/FN-200/reject-plan");
    expect(res.status).not.toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/must be in 'triage'/i);
  });

  it("still rejects a card that is NOT in its workflow's intake column", async () => {
    // The guard must narrow, not disappear: an in-progress card is still not approvable.
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue({ ...PLANNING_TASK, column: "in-progress" }),
    });
    const res = await performRequest(createApp(store), "POST", "/api/tasks/FN-200/approve-plan");
    expect(res.status).toBe(400);
  });
});
