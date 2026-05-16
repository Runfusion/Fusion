import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import * as worktreePool from "../worktree-pool.js";
import { resolveWorktreesDir } from "../worktree-paths.js";
import { createMockStore, mockedCreateFnAgent, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4114",
    title: "Liveness test",
    description: "",
    column: "in-progress",
    worktree: "/repo/.worktrees/swift-falcon",
    branch: "fusion/fn-4114",
    taskDoneRetryCount: 0,
    steps: [{ name: "Step 1", status: "in-progress" as const }],
    currentStep: 0,
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("FN-4114 worktree liveness assertion", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("abc123\n");
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      return Buffer.from("");
    });
  });

  it("FN-4114 aborts before createFnAgent when worktree is missing", async () => {
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(false);
    const store = createMockStore();
    store.getTask.mockResolvedValue(task());

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(task() as any);

    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-4114 aborts when worktree realpath collides with repo root", async () => {
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("abc123\n");
      return Buffer.from("");
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(task({ worktree: "/repo" }));

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(task({ worktree: "/repo" }) as any);

    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it.each([
    { name: "default worktreesDir", settings: {}, outsidePath: "/repo/not-a-worktree" },
    { name: "absolute worktreesDir", settings: { worktreesDir: "/custom/trees" }, outsidePath: "/repo/not-a-worktree" },
    { name: "relative worktreesDir", settings: { worktreesDir: "custom-trees" }, outsidePath: "/repo/not-a-worktree" },
  ])("FN-4114 enforces configured worktreesDir ($name)", async ({ settings, outsidePath }) => {
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    const store = createMockStore();
    const baseSettings = await store.getSettings();
    const mergedSettings = { ...baseSettings, ...settings };
    store.getSettings.mockResolvedValue(mergedSettings);

    const allowedWorktree = `${resolveWorktreesDir("/repo", mergedSettings as any)}/fn-4114`;
    store.getTask.mockResolvedValue(task({ worktree: outsidePath }));

    const rejectExecutor = new TaskExecutor(store as any, "/repo");
    await rejectExecutor.execute(task({ worktree: outsidePath }) as any);

    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });

    mockedCreateFnAgent.mockReset();
    mockedCreateFnAgent.mockImplementation(async () => ({
      session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() },
    }) as any);

    store.moveTask.mockReset();
    store.getTask.mockResolvedValue(task({ worktree: allowedWorktree }));

    const acceptExecutor = new TaskExecutor(store as any, "/repo");
    await acceptExecutor.execute(task({ worktree: allowedWorktree }) as any);

    expect(mockedCreateFnAgent).toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-4114 accepts usable pool-acquired worktrees", async () => {
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    const store = createMockStore();
    store.getTask.mockResolvedValue(task());

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() },
    }) as any);

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(task() as any);

    expect(mockedCreateFnAgent).toHaveBeenCalled();
  });
});
