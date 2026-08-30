// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Task, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { resumeExternallyBlockedTask } from "../routes/task-external-block-resume.js";
import { request as performRequest } from "../test-request.js";

const IR = {
  version: "v2",
  name: "external-block-resume",
  columns: [
    { id: "planning", name: "Planning", traits: [{ trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "review", name: "Review", traits: [{ trait: "human-review" }] },
  ],
  nodes: [
    { id: "start", kind: "start" },
    { id: "implement", kind: "execute", column: "building" },
    { id: "code-review", kind: "prompt", column: "review" },
  ],
  edges: [
    { from: "start", to: "implement" },
    { from: "implement", to: "code-review" },
  ],
} as never;

function blockedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-209",
    title: "External obstacle",
    description: "Resume exact verification step",
    column: "building",
    dependencies: [],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implementation", status: "done" },
      { name: "Testing & Verification", status: "in-progress" },
    ],
    currentStep: 2,
    workflowStepResults: [{ workflowStepId: "plan-review", status: "passed" }],
    worktree: "/worktrees/fn-209",
    branch: "fusion/fn-209",
    baseCommitSha: "base-sha",
    status: "blocked",
    error: "BLOCKED: host-environment/ENOSPC: no space left on device, write",
    paused: true,
    pausedReason: "external-block",
    externalBlock: {
      origin: "host-environment",
      code: "ENOSPC",
      message: "no space left on device, write",
      source: "agent-declaration",
      blockedAt: "2026-08-28T00:00:00.000Z",
      resume: {
        column: "building",
        nodeId: "implement",
        currentStep: 2,
        worktree: "/worktrees/fn-209",
        branch: "fusion/fn-209",
      },
    },
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(row: Task) {
  const items: Array<Record<string, unknown>> = [];
  const store = {
    getRootDir: vi.fn(() => "/project"),
    getSettings: vi.fn().mockResolvedValue({}),
    getTask: vi.fn(async () => structuredClone(row)),
    listTasks: vi.fn(async () => [structuredClone(row)]),
    withPlanningLifecycleLock: vi.fn(async (_taskId: string, work: () => Promise<unknown>) => await work()),
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "wf-external-block" }),
    getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "wf-external-block", name: "External block", ir: IR }),
    listWorkflowWorkItemsForTask: vi.fn(async () => structuredClone(items)),
    replaceActiveTaskWorkflowContinuation: vi.fn(async (input: Record<string, unknown>) => {
      for (const item of items) {
        if (item.kind === "task" && ["runnable", "running", "held", "retrying"].includes(String(item.state))) {
          item.state = "cancelled";
        }
      }
      items.push({ id: `continuation-${items.length}`, ...input });
      return input;
    }),
    updateTask: vi.fn(async (_taskId: string, patch: Partial<Task>) => {
      Object.assign(row, patch);
      return structuredClone(row);
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  };
  return { store: store as unknown as TaskStore, items };
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

async function createPrompt(root: string) {
  const taskDir = join(root, ".fusion", "tasks", "FN-209");
  await mkdir(taskDir, { recursive: true });
  const promptPath = join(taskDir, "PROMPT.md");
  await writeFile(promptPath, "# Existing approved plan\n");
  return promptPath;
}

afterEach(() => vi.restoreAllMocks());

describe("external-block Retry", () => {
  it("resumes the recorded node without changing completed work or implementation artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-external-block-resume-"));
    const promptPath = await createPrompt(root);
    const row = blockedTask();
    const before = structuredClone(row);
    const { store, items } = createStore(row);
    vi.mocked(store.getRootDir).mockReturnValue(root);

    const response = await performRequest(createApp(store), "POST", "/api/tasks/FN-209/retry");

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(row).toMatchObject({
      column: before.column,
      steps: before.steps,
      currentStep: before.currentStep,
      worktree: before.worktree,
      branch: before.branch,
      baseCommitSha: before.baseCommitSha,
      workflowStepResults: before.workflowStepResults,
      paused: false,
      externalBlock: null,
    });
    expect(row.status).toBeNull();
    expect(row.error).toBeNull();
    await expect(readFile(promptPath, "utf8")).resolves.toBe("# Existing approved plan\n");
    expect(items).toEqual([
      expect.objectContaining({
        nodeId: "implement",
        state: "runnable",
        sourceColumn: "building",
        targetColumn: "building",
      }),
    ]);
    expect(store.updateTask).toHaveBeenCalledOnce();
    expect(store.updateTask).toHaveBeenCalledWith("FN-209", expect.not.objectContaining({
      steps: expect.anything(),
      currentStep: expect.anything(),
      worktree: expect.anything(),
      branch: expect.anything(),
      workflowStepResults: expect.anything(),
    }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-209", expect.stringContaining("resuming workflow at implement"));
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:external-block-cleared",
      metadata: expect.objectContaining({ code: "ENOSPC", resumeNodeId: "implement" }),
    }));
    expect(JSON.stringify(vi.mocked(store.recordRunAuditEvent).mock.calls)).not.toContain("no space left on device");
  });

  it("falls back to the recorded column entry when the blocked node id is absent", async () => {
    const row = blockedTask({
      externalBlock: {
        ...blockedTask().externalBlock!,
        resume: { column: "building", currentStep: 2, worktree: "/worktrees/fn-209", branch: "fusion/fn-209" },
      },
    });
    const { store, items } = createStore(row);

    const result = await resumeExternallyBlockedTask({ store: store as never, taskId: row.id });

    expect(result).toMatchObject({ kind: "resumed", nodeId: "implement" });
    expect(items[0]).toMatchObject({ nodeId: "implement" });
  });

  it("refuses a duplicate Retry while the external-block continuation is still pending", async () => {
    const row = blockedTask();
    const { store, items } = createStore(row);
    const app = createApp(store);

    expect((await performRequest(app, "POST", "/api/tasks/FN-209/retry")).status).toBe(200);
    const duplicate = await performRequest(app, "POST", "/api/tasks/FN-209/retry");

    expect(duplicate.status).toBe(409);
    expect(JSON.stringify(duplicate.body)).toContain("already resumed");
    expect(items).toHaveLength(1);
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledOnce();
  });

  it("signals non-blocked tasks without mutating them so the existing retry router remains authoritative", async () => {
    const row = blockedTask({ status: "failed", externalBlock: undefined, paused: undefined, pausedReason: undefined });
    const before = structuredClone(row);
    const { store } = createStore(row);

    const result = await resumeExternallyBlockedTask({ store: store as never, taskId: row.id });

    expect(result).toEqual({ kind: "not-blocked" });
    expect(row).toEqual(before);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
  });
});
