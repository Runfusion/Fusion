import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, setTaskCreatedHook } from "@fusion/core";

const hookSpy = vi.hoisted(() => vi.fn(async () => {}));
const registerGithubTrackingHookMock = vi.hoisted(() => vi.fn(() => {
  setTaskCreatedHook(async (task, store) => {
    try {
      await hookSpy(task, store);
    } catch {
      // Best-effort, mirrors real dashboard hook contract.
    }
  });
}));

vi.mock("@fusion/dashboard", () => ({
  registerGithubTrackingHook: registerGithubTrackingHookMock,
}));

vi.mock("@fusion/engine", () => ({
  createFnAgent: vi.fn(),
  fetchWebContent: vi.fn(),
  assertNoSecretPlaintext: vi.fn(),
}));

async function loadExtension() {
  const mod = await import("../extension.js");
  return mod.default;
}

describe("extension github tracking hook wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTaskCreatedHook(undefined);
  });

  afterEach(async () => {
    setTaskCreatedHook(undefined);
    vi.restoreAllMocks();
  });

  it("fn_task_create triggers registered task-created hook exactly once", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "fn-5057-extension-gh-"));
    const cwd = join(repoRoot, ".worktrees", "feature");
    try {
      await mkdir(join(repoRoot, ".fusion"), { recursive: true });

      const extension = await loadExtension();
      const tools = new Map<string, any>();
      extension({
        registerTool: (def: any) => tools.set(def.name, def),
        registerCommand: vi.fn(),
        registerShortcut: vi.fn(),
        registerFlag: vi.fn(),
        on: vi.fn(),
      } as any);

      extension({
        registerTool: (def: any) => tools.set(def.name, def),
        registerCommand: vi.fn(),
        registerShortcut: vi.fn(),
        registerFlag: vi.fn(),
        on: vi.fn(),
      } as any);

      expect(registerGithubTrackingHookMock).toHaveBeenCalledTimes(2);

      const tool = tools.get("fn_task_create");
      const taskStore = new TaskStore(repoRoot, undefined, { inMemoryDb: false });
      await taskStore.init();
      await taskStore.updateSettings({
        githubTrackingEnabledByDefault: true,
        githubTrackingDefaultRepo: "owner/repo",
      });

      const result = await tool.execute(
        "call-1",
        { description: "extension-created task" },
        undefined,
        undefined,
        { cwd },
      );

      expect(result.details?.taskId).toMatch(/^FN-/);
      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(hookSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ id: result.details.taskId }),
      );

      const persisted = await taskStore.getTask(result.details.taskId);
      expect(persisted).toBeTruthy();
      expect(persisted?.githubTracking?.enabled).toBe(true);
      taskStore.close();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
