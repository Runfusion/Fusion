// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskDetail, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

const SPLIT_PLANNING_IR = {
  version: "v2",
  name: "split-planning",
  columns: [
    { id: "ideas", name: "Ideas", traits: [{ trait: "intake", config: { autoTriage: false } }] },
    { id: "todo", name: "Planning", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
    { id: "in-review", name: "In review", traits: [{ trait: "human-review" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "ideas" },
    { id: "planning", kind: "prompt", column: "todo", config: { seam: "planning" } },
    { id: "plan-review", kind: "optional-group", column: "todo" },
    { id: "plan-replan", kind: "gate", column: "todo", config: { workflowAction: "plan-replan" } },
    { id: "execute", kind: "prompt", column: "in-progress" },
    { id: "end", kind: "end", column: "done" },
  ],
  edges: [
    { from: "start", to: "planning" },
    { from: "planning", to: "plan-review" },
    { from: "plan-review", to: "execute" },
    { from: "execute", to: "end" },
  ],
};

const V1_IR = { version: "v1", name: "legacy", steps: [] };

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-228",
    title: "Human plan review",
    description: "Review before execution",
    column: "todo",
    status: "awaiting-approval",
    awaitingApprovalReason: null,
    approvedPlanFingerprint: "old-fingerprint",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [{
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "passed",
      startedAt: "2026-08-28T11:39:00.000Z",
      completedAt: "2026-08-28T11:39:01.000Z",
    }],
    createdAt: "2026-08-28T11:39:00.000Z",
    updatedAt: "2026-08-28T11:39:00.000Z",
    prompt: "# Reviewed plan\n",
    ...overrides,
  } as TaskDetail;
}

function createStore(options: { row?: TaskDetail; ir?: unknown } = {}) {
  const row = options.row ?? task();
  const ir = options.ir ?? SPLIT_PLANNING_IR;
  const root = mkdtempSync(join(tmpdir(), "fusion-plan-approval-split-"));
  const taskDir = join(root, ".fusion", "tasks", row.id);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "PROMPT.md"), row.prompt ?? "# Reviewed plan\n");

  const store = {
    getSettings: vi.fn().mockResolvedValue({}),
    getRootDir: vi.fn().mockReturnValue(root),
    getTask: vi.fn().mockResolvedValue(row),
    updateTask: vi.fn().mockResolvedValue(row),
    withPlanningLifecycleLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => await fn()),
    moveTask: vi.fn().mockImplementation(async (_id: string, column: string) => ({ ...row, column })),
    logEntry: vi.fn().mockResolvedValue(undefined),
    lockCurrentPlanWhilePlanningLocked: vi.fn().mockResolvedValue(undefined),
    reconcileSpecDriftWhilePlanningLocked: vi.fn().mockResolvedValue(undefined),
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "wf-split" }),
    getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "wf-split", name: "Split", ir }),
    listWorkflowDefinitions: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    off: vi.fn(),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;

  return { store, root, promptPath: join(taskDir, "PROMPT.md") };
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

function post(store: TaskStore, path: string, body?: object) {
  return performRequest(
    createApp(store),
    "POST",
    path,
    body ? JSON.stringify(body) : undefined,
    body ? { "content-type": "application/json" } : undefined,
  );
}

describe("plan approval on a split intake and hold workflow", () => {
  it("approves a task parked in the hold planning column", async () => {
    const { store } = createStore();

    const response = await post(store, "/api/tasks/FN-228/approve-plan");

    expect(response.status).toBe(200);
  });

  it("rejects and regenerates in the current planning column", async () => {
    const { store, promptPath } = createStore();

    const response = await post(store, "/api/tasks/FN-228/reject-plan");

    expect(response.status).toBe(200);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(existsSync(promptPath)).toBe(false);
    expect(store.updateTask).toHaveBeenCalledWith("FN-228", {
      status: null,
      approvedPlanFingerprint: null,
    });
  });

  it("preserves and supersedes the plan while respecifying in place", async () => {
    const { store, promptPath } = createStore();

    const response = await post(store, "/api/tasks/FN-228/spec/revise", {
      feedback: "Clarify the acceptance criteria",
      preservePlan: true,
    });

    expect(response.status).toBe(200);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(existsSync(promptPath)).toBe(true);
    const patch = vi.mocked(store.updateTask).mock.calls.at(-1)?.[1];
    expect(patch).toMatchObject({
      status: "needs-replan",
      approvedPlanFingerprint: null,
      awaitingApprovalReason: null,
    });
    expect(patch?.workflowStepResults?.[0]).toMatchObject({
      workflowStepId: "plan-review",
      supersededReason: "respecify",
    });
  });

  it("removes the plan while destructively respecifying in place", async () => {
    const { store, promptPath } = createStore();

    const response = await post(store, "/api/tasks/FN-228/spec/revise", {
      feedback: "Start the plan over",
    });

    expect(response.status).toBe(200);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(existsSync(promptPath)).toBe(false);
    expect(store.updateTask).toHaveBeenCalledWith("FN-228", { status: "needs-replan" });
  });

  it("still moves respecify from an implementation column to intake", async () => {
    const { store } = createStore({ row: task({ column: "in-progress", status: "failed" }) });

    const response = await post(store, "/api/tasks/FN-228/spec/revise", {
      feedback: "Rework the approach",
      preservePlan: true,
    });

    expect(response.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-228", "ideas");
  });

  it("moves respecify to intake when a v1 workflow cannot declare planning placement", async () => {
    const { store } = createStore({ row: task({ column: "todo", status: "failed" }), ir: V1_IR });

    const response = await post(store, "/api/tasks/FN-228/spec/revise", {
      feedback: "Rework the legacy plan",
      preservePlan: true,
    });

    expect(response.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-228", "triage");
  });

  it("moves rejection to intake when a v1 workflow cannot declare planning placement", async () => {
    const { store } = createStore({ ir: V1_IR });

    const response = await post(store, "/api/tasks/FN-228/reject-plan");

    expect(response.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-228", "triage", {
      preserveStatus: true,
      workflowMoveSource: "plan-approval",
    });
  });

  it.each(["approve-plan", "reject-plan"])("refuses %s outside the planning lane", async (route) => {
    const { store } = createStore({ row: task({ column: "in-progress" }) });

    const response = await post(store, `/api/tasks/FN-228/${route}`);

    expect(response.status).toBe(400);
  });
});
