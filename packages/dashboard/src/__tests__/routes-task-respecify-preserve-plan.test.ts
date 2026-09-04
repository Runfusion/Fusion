// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

const IR = {
  version: "v2",
  name: "respecify",
  columns: [
    { id: "planning", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "planning" },
    { id: "execute", kind: "execute", column: "building" },
  ],
  edges: [{ from: "start", to: "execute" }],
} as never;

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-212",
    title: "Respecify",
    description: "Revise the plan",
    column: "planning",
    status: "awaiting-approval",
    awaitingApprovalReason: "plan-review-replan-cap",
    approvedPlanFingerprint: "approved-fingerprint",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [
      { workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed" },
      { workflowStepId: "code-review", workflowStepName: "Code Review", status: "passed" },
    ],
    createdAt: "2026-08-28T06:24:00.000Z",
    updatedAt: "2026-08-28T06:24:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(row: Task, rootDir: string): TaskStore {
  const applyPatch = (patch: Partial<Task>) => {
    for (const [key, value] of Object.entries(patch)) {
      (row as unknown as Record<string, unknown>)[key] = value;
    }
  };
  return {
    getRootDir: vi.fn(() => rootDir),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getTask: vi.fn(async () => structuredClone(row)),
    listTasks: vi.fn(async () => [structuredClone(row)]),
    searchTasks: vi.fn().mockResolvedValue([]),
    findRecentTasksBySourceParentTaskId: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(async (input: Partial<Task>) => {
      applyPatch(input);
      return structuredClone(row);
    }),
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "wf-respecify" }),
    getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "wf-respecify", name: "Respecify", ir: IR }),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      applyPatch(patch);
      return structuredClone(row);
    }),
    moveTask: vi.fn(async (_id: string, column: string) => {
      row.column = column;
      return structuredClone(row);
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

async function createPrompt(root: string): Promise<string> {
  const taskDir = join(root, ".fusion", "tasks", "FN-212");
  await mkdir(taskDir, { recursive: true });
  const promptPath = join(taskDir, "PROMPT.md");
  await writeFile(promptPath, "# Existing plan\n\n## Steps\n\n### Step 0: Revise\n");
  return promptPath;
}

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(overrides: Partial<Task> = {}) {
  const root = await mkdtemp(join(tmpdir(), "fusion-respecify-route-"));
  roots.push(root);
  const promptPath = await createPrompt(root);
  const row = taskFixture(overrides);
  const store = createStore(row, root);
  return { root, promptPath, row, store, app: createApp(store) };
}

describe("POST /tasks/:id/spec/revise preservePlan", () => {
  it("keeps PROMPT.md at intake and invalidates approval plus Plan Review evidence", async () => {
    const { promptPath, row, store, app } = await setup();

    const response = await performRequest(app, "POST", "/api/tasks/FN-212/spec/revise", JSON.stringify({
      feedback: "Change the acceptance criteria",
      preservePlan: true,
    }), { "Content-Type": "application/json" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await expect(readFile(promptPath, "utf8")).resolves.toContain("# Existing plan");
    expect(row.status).toBe("needs-replan");
    expect(row.approvedPlanFingerprint).toBeNull();
    expect(row.awaitingApprovalReason).toBeNull();
    expect(row.workflowStepResults?.[0]).toMatchObject({ supersededReason: "respecify" });
    expect(row.workflowStepResults?.[0]?.supersededAt).toEqual(expect.any(String));
    expect(row.workflowStepResults?.[1]?.supersededAt).toBeUndefined();
    expect(store.logEntry).toHaveBeenCalledWith("FN-212", "AI spec revision requested", "Change the acceptance criteria");
  });

  it("moves a non-intake task to intake and applies the same invalidation", async () => {
    const { promptPath, row, store, app } = await setup({ column: "building" });

    const response = await performRequest(app, "POST", "/api/tasks/FN-212/spec/revise", JSON.stringify({
      feedback: "Use a smaller scope",
      preservePlan: true,
    }), { "Content-Type": "application/json" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-212", "planning");
    expect(row).toMatchObject({ column: "planning", status: "needs-replan", approvedPlanFingerprint: null, awaitingApprovalReason: null });
    await expect(readFile(promptPath, "utf8")).resolves.toContain("# Existing plan");
  });

  it("clears an ordinary awaiting-approval hold", async () => {
    const { row, app } = await setup({ awaitingApprovalReason: undefined });

    const response = await performRequest(app, "POST", "/api/tasks/FN-212/spec/revise", JSON.stringify({
      feedback: "Revise before I approve",
      preservePlan: true,
    }), { "Content-Type": "application/json" });

    expect(response.status).toBe(200);
    expect(row.status).toBe("needs-replan");
    expect(row.awaitingApprovalReason).toBeNull();
  });

  it("keeps the legacy destructive route behavior when preservePlan is absent", async () => {
    const { promptPath, row, store, app } = await setup();

    const response = await performRequest(app, "POST", "/api/tasks/FN-212/spec/revise", JSON.stringify({
      feedback: "Start over",
    }), { "Content-Type": "application/json" });

    expect(response.status).toBe(200);
    await expect(readFile(promptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(row.status).toBe("needs-replan");
    expect(row.approvedPlanFingerprint).toBe("approved-fingerprint");
    expect(store.updateTask).toHaveBeenCalledWith("FN-212", { status: "needs-replan" });
  });

  it("rejects a non-boolean preservePlan value", async () => {
    const { app } = await setup();
    const response = await performRequest(app, "POST", "/api/tasks/FN-212/spec/revise", JSON.stringify({
      feedback: "Revise",
      preservePlan: "yes",
    }), { "Content-Type": "application/json" });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("preservePlan must be a boolean");
  });
});

describe("retired requirePlanApproval route field", () => {
  it("ignores the legacy field on task creation", async () => {
    const { store, app } = await setup();

    const response = await performRequest(app, "POST", "/api/tasks", JSON.stringify({
      description: "Create using project approval policy",
      requirePlanApproval: true,
      bypassDuplicateCheck: true,
    }), { "Content-Type": "application/json" });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const createInput = vi.mocked(store.createTask).mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(createInput).not.toHaveProperty("requirePlanApproval");
  });

  it("ignores boolean and formerly-invalid legacy values on task updates", async () => {
    const { store, app } = await setup();

    const enabled = await performRequest(app, "PATCH", "/api/tasks/FN-212", JSON.stringify({
      requirePlanApproval: true,
    }), { "Content-Type": "application/json" });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    const enabledPatch = vi.mocked(store.updateTask).mock.calls.at(-1)?.[1] as unknown as Record<string, unknown>;
    expect(enabledPatch).not.toHaveProperty("requirePlanApproval");

    const legacyInvalid = await performRequest(app, "PATCH", "/api/tasks/FN-212", JSON.stringify({
      requirePlanApproval: "yes",
    }), { "Content-Type": "application/json" });
    expect(legacyInvalid.status, JSON.stringify(legacyInvalid.body)).toBe(200);
    const invalidPatch = vi.mocked(store.updateTask).mock.calls.at(-1)?.[1] as unknown as Record<string, unknown>;
    expect(invalidPatch).not.toHaveProperty("requirePlanApproval");
  });
});
