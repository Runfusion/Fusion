import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, resolveTaskGithubTracking, setTaskCreatedHook } from "@fusion/core";
import { createDelegateTaskTool, createTaskCreateTool } from "../agent-tools.js";

const githubTrackingHookEntry = "../../../dashboard/src/github-tracking-hook.js";
const githubTrackingEntry = "../../../dashboard/src/github-tracking.js";
const githubTrackingHookModulePromise: Promise<any> = import(/* @vite-ignore */ githubTrackingHookEntry);
const githubTrackingModulePromise: Promise<any> = import(/* @vite-ignore */ githubTrackingEntry);

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("agent tool github tracking end-to-end", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    setTaskCreatedHook(undefined);
    vi.restoreAllMocks();
    rootDir = makeTmpDir("kb-engine-agent-tools-gh-track-e2e-");
    globalDir = makeTmpDir("kb-engine-agent-tools-gh-track-e2e-global-");
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
  ])("invokes maybeCreateTrackingIssue for $name", async ({ run }) => {
    const githubTrackingModule = await githubTrackingModulePromise;
    const githubTrackingHookModule = await githubTrackingHookModulePromise;
    const maybeCreateSpy = vi.spyOn(githubTrackingModule, "maybeCreateTrackingIssue").mockResolvedValue({
      created: false,
      reason: "tracking_disabled",
    });

    githubTrackingHookModule.registerGithubTrackingHook();

    const result = await run();
    const taskId = (result as { details?: { taskId?: string } }).details?.taskId as string;
    expect(taskId).toMatch(/^FN-/);

    expect(maybeCreateSpy).toHaveBeenCalledTimes(1);
    const [taskArg, depsArg] = (maybeCreateSpy.mock.calls[0] ?? []) as [
      { id?: string } | undefined,
      { projectSettings?: unknown; globalSettings?: unknown } | undefined,
    ];
    expect(taskArg?.id).toBe(taskId);

    const persisted = await store.getTask(taskId);
    expect(persisted).toBeTruthy();
    expect(persisted?.githubTracking?.enabled).toBe(true);
    const resolvedTracking = resolveTaskGithubTracking(
      persisted!,
      depsArg?.projectSettings as never,
      depsArg?.globalSettings as never,
    );
    expect(resolvedTracking.enabled).toBe(true);
    expect(resolvedTracking.repo).toEqual({ owner: "owner", repo: "repo" });
  });
});
