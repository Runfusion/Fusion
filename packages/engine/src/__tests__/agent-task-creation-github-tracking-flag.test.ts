import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, setTaskCreatedHook } from "@fusion/core";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import { createDelegateTaskTool, createTaskCreateTool } from "../agent-tools.js";

const githubTrackingHookModulePromise: Promise<any> = import(
  new URL("../../../dashboard/src/github-tracking-hook.js", import.meta.url).href
);
const githubTrackingModulePromise: Promise<any> = import(
  new URL("../../../dashboard/src/github-tracking.js", import.meta.url).href
);

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("agent task creation githubTracking.enabled persistence", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    setTaskCreatedHook(undefined);
    vi.restoreAllMocks();
    rootDir = makeTmpDir("kb-engine-agent-task-create-gh-flag-");
    globalDir = makeTmpDir("kb-engine-agent-task-create-gh-flag-global-");
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    await store.updateSettings({
      githubTrackingEnabledByDefault: true,
      githubTrackingDefaultRepo: "owner/repo",
    });
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
      run: async () => createTaskCreateTool(store, { sourceType: "api" }).execute(
        "call-1",
        { description: "agent-created tracked task" } as never,
        undefined,
        undefined,
        {} as never,
      ),
    },
    {
      name: "fn_delegate_task",
      run: async () => createDelegateTaskTool({
        getAgent: vi.fn().mockResolvedValue({ id: "agent-1", name: "Worker", role: "executor", state: "idle" }),
      } as never, store).execute(
        "call-1",
        { agent_id: "agent-1", description: "delegated tracked task" } as never,
        undefined,
        undefined,
        {} as never,
      ),
    },
    {
      name: "heartbeat trackedCreateTool",
      run: async () => {
        const monitor = new HeartbeatMonitor({
          store: { listAgents: vi.fn().mockResolvedValue([]), getAgent: vi.fn().mockResolvedValue(null), getRatingSummary: vi.fn().mockResolvedValue({ averageScore: null, trend: "stable", totalRatings: 0, categoryAverages: {} }), getRatings: vi.fn().mockResolvedValue([]), updateAgent: vi.fn().mockResolvedValue(undefined) } as never,
          taskStore: store,
          rootDir,
        });
        const tool = monitor.createHeartbeatTools("agent-1", store, "FN-000").find((entry) => entry.name === "fn_task_create");
        return tool!.execute("call-1", { description: "heartbeat tracked task" } as never, undefined, undefined, {} as never);
      },
    },
  ])("persists githubTracking.enabled and invokes tracking hook for $name", async ({ run }) => {
    const githubTrackingHookModule = await githubTrackingHookModulePromise;
    const githubTrackingModule = await githubTrackingModulePromise;

    const maybeCreateSpy = vi.spyOn(githubTrackingModule, "maybeCreateTrackingIssue").mockImplementation(async () => ({
      created: false,
      reason: "no_repo_configured",
    }));

    githubTrackingHookModule.registerGithubTrackingHook();

    const result = await run();
    const taskId = (result as { details?: { taskId?: string } }).details?.taskId as string;

    expect(maybeCreateSpy).toHaveBeenCalledTimes(1);

    const persisted = await store.getTask(taskId);
    expect(persisted?.githubTracking?.enabled).toBe(true);
  });
});
