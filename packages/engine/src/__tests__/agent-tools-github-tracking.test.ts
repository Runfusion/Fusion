import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, setTaskCreatedHook, type Task } from "@fusion/core";
import { createAgentTask, createTaskCreateTool, createDelegateTaskTool } from "../agent-tools.js";

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("agent task creation github-tracking hook integration", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    setTaskCreatedHook(undefined);
    rootDir = makeTmpDir("kb-engine-agent-tools-gh-track-");
    globalDir = makeTmpDir("kb-engine-agent-tools-gh-track-global-");
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    setTaskCreatedHook(undefined);
    store.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  });

  it.each([
    {
      name: "fn_task_create",
      createTool: () => createTaskCreateTool(store, { sourceType: "api" }),
      params: { description: "agent-created triage task" },
      expected: { description: "agent-created triage task", column: "triage", sourceType: "api" },
    },
    {
      name: "fn_delegate_task",
      createTool: () => createDelegateTaskTool({
        getAgent: vi.fn().mockResolvedValue({ id: "agent-1", name: "Worker", role: "executor", state: "idle" }),
      } as never, store),
      params: { agent_id: "agent-1", description: "delegated tracked task" },
      expected: { description: "delegated tracked task", assignedAgentId: "agent-1", column: "todo", sourceType: "api" },
    },
  ])("calls the post-create hook for $name", async ({ createTool, params, expected }) => {
    const hook = vi.fn(async (_task: Task) => {});
    setTaskCreatedHook(hook);

    const result = await createTool().execute("call-1", params as never, undefined, undefined, {} as never);

    expect(result.details).toHaveProperty("taskId");
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[0]).toEqual(expect.objectContaining(expected));
  });

  it.each([
    {
      name: "fn_task_create",
      run: async () => createTaskCreateTool(store, { sourceType: "api" }).execute("call-1", { description: "fails softly" } as never, undefined, undefined, {} as never),
    },
    {
      name: "fn_delegate_task",
      run: async () => createDelegateTaskTool({
        getAgent: vi.fn().mockResolvedValue({ id: "agent-1", name: "Worker", role: "executor", state: "idle" }),
      } as never, store).execute("call-1", { agent_id: "agent-1", description: "fails softly" } as never, undefined, undefined, {} as never),
    },
  ])("does not throw when hook rejects for $name", async ({ run }) => {
    setTaskCreatedHook(vi.fn(async () => {
      throw new Error("hook failed");
    }));

    await expect(run()).resolves.toBeTruthy();
  });
});

describe("createAgentTask githubTracking prefill", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    setTaskCreatedHook(undefined);
    rootDir = makeTmpDir("kb-engine-agent-tools-gh-track-prefill-");
    globalDir = makeTmpDir("kb-engine-agent-tools-gh-track-prefill-global-");
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    setTaskCreatedHook(undefined);
    store.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  });

  async function createViaAgentTask(params: Partial<{ githubTracking: { enabled?: boolean; repoOverride?: string } }> = {}): Promise<{ githubTracking?: { enabled?: boolean; repoOverride?: string } }> {
    const created = await createAgentTask(store, {
      description: "tracking defaults task",
      source: { sourceType: "api" },
      ...params,
    });
    const task = await store.getTask(created.task.id);
    return task;
  }

  it("prefills enabled=true from project defaults", async () => {
    await store.updateSettings({
      githubTrackingEnabledByDefault: true,
      githubTrackingDefaultRepo: "owner/repo",
    });

    const task = await createViaAgentTask();
    expect(task.githubTracking?.enabled).toBe(true);
    expect(task.githubTracking?.repoOverride).toBe("owner/repo");
  });

  it("does not prefill when project defaults disabled", async () => {
    await store.updateSettings({
      githubTrackingEnabledByDefault: false,
      githubTrackingDefaultRepo: "owner/repo",
    });

    const task = await createViaAgentTask();
    expect(task.githubTracking).toBeUndefined();
  });

  it("preserves explicit opt-out enabled=false", async () => {
    await store.updateSettings({
      githubTrackingEnabledByDefault: true,
      githubTrackingDefaultRepo: "owner/repo",
    });

    const task = await createViaAgentTask({ githubTracking: { enabled: false } });
    expect(task.githubTracking?.enabled).toBe(false);
  });

  it("sets enabled=true even when no repo is configured", async () => {
    await store.updateSettings({
      githubTrackingEnabledByDefault: true,
      githubTrackingDefaultRepo: undefined,
    });

    const task = await createViaAgentTask();
    expect(task.githubTracking?.enabled).toBe(true);
    expect(task.githubTracking?.repoOverride).toBeUndefined();
  });

  it("uses global-only defaults when project settings are empty", async () => {
    await store.getGlobalSettingsStore().updateSettings({
      githubTrackingDefaultEnabledForNewTasks: true,
      githubTrackingDefaultRepo: "global/repo",
    });
    vi.spyOn(store, "getSettings").mockResolvedValue({} as never);

    const task = await createViaAgentTask();
    expect(task.githubTracking?.enabled).toBe(true);
    expect(task.githubTracking?.repoOverride).toBe("global/repo");
  });
});
