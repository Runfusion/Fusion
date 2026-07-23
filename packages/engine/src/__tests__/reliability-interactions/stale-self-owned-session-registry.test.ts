import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";
import { createMockStore, mockedExistsSync, resetExecutorMocks } from "../executor-test-helpers.js";
import * as worktreePoolModule from "../../worktree/worktree-pool.js";

const ROOT = "/tmp/test";
const PATH = "/tmp/test/.worktrees/fn-4976";
const BRANCH = "fusion/fn-4976";
const TASK_ID = "FN-4976";

describe("FN-4976: stale self-owned activeSessionRegistry deadlock backstop", () => {
  beforeEach(() => {
    resetExecutorMocks();
    activeSessionRegistry.unregisterPath(PATH);
    mockedExistsSync.mockImplementation((input: Parameters<typeof mockedExistsSync>[0]) => input === PATH);
  });

  afterEach(() => {
    activeSessionRegistry.unregisterPath(PATH);
  });

  it("FN-4976 clears same-task stale activeSessionRegistry entry and cleanup succeeds", async () => {
    const store = createMockStore();
    store.listTasks.mockResolvedValue([]);
    activeSessionRegistry.registerPath(PATH, { taskId: TASK_ID, kind: "executor", ownerKey: TASK_ID });
    // FN-5256: backdate so the new min-idle window doesn't refuse the reconcile.
    (activeSessionRegistry.lookupByPath(PATH) as any).registeredAt = 0;

    const executor = new TaskExecutor(store, ROOT);
    const removeSpy = vi.spyOn(worktreePoolModule, "removeWorktree").mockResolvedValue(undefined);
    const result = await (executor as any).cleanupConflictingWorktree(PATH, BRANCH, TASK_ID);

    expect(result).toBe(true);
    expect(removeSpy).toHaveBeenCalled();
    expect(activeSessionRegistry.lookupByPath(PATH)).toBeNull();
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      "Cleared stale self-owned active-session entry before remove",
      PATH,
    );
  });

  it("FN-4976 does not clear foreign-owned activeSessionRegistry entry and FN-4811 refusal still fires", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    (executor as any).addActiveWorktree("FN-OTHER", PATH);
    store.listTasks.mockResolvedValue([]);
    activeSessionRegistry.registerPath(PATH, { taskId: "FN-OTHER", kind: "executor", ownerKey: "FN-OTHER" });

    const result = await (executor as any).cleanupConflictingWorktree(PATH, BRANCH, TASK_ID);

    expect(result).toBe(false);
    expect(activeSessionRegistry.lookupByPath(PATH)?.taskId).toBe("FN-OTHER");
    const messages = store.logEntry.mock.calls.map((call: any[]) => String(call[1] ?? ""));
    expect(messages.some((m: string) => m.includes("Refused to remove conflicting worktree"))).toBe(true);
    expect(messages.some((m: string) => m.includes("Cleared stale self-owned active-session entry before remove"))).toBe(false);
  });

  it("FN-4976 leaves behavior unchanged when no stale entry exists", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    store.listTasks.mockResolvedValue([]);
    const unregisterSpy = vi.spyOn(activeSessionRegistry, "unregisterPath");
    const removeSpy = vi.spyOn(worktreePoolModule, "removeWorktree").mockResolvedValue(undefined);

    const result = await (executor as any).cleanupConflictingWorktree(PATH, BRANCH, TASK_ID);

    expect(removeSpy).toHaveBeenCalled();

    expect(result).toBe(true);
    expect(unregisterSpy).not.toHaveBeenCalledWith(PATH);
    const messages = store.logEntry.mock.calls.map((call: any[]) => String(call[1] ?? ""));
    expect(messages.some((m: string) => m.includes("Cleared stale self-owned active-session entry before remove"))).toBe(false);
  });
});
