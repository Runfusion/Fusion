import { describe, it, expect, vi } from "vitest";
import { SelfHealingManager } from "../../self-healing.js";

describe("FN-4967: self-healing multi-pr conflict reclaim", () => {
  function createManager(tasks: any[]) {
    const store = {
      listTasks: vi.fn().mockResolvedValue(tasks),
      getTask: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    } as any;
    const manager = new SelfHealingManager(store, { rootDir: "/tmp" } as any);
    return { manager, store };
  }

  it("filters out tasks with no conflicting PRs", async () => {
    const { manager } = createManager([
      { id: "FN-1", prInfo: { number: 1, mergeable: "clean" } },
      { id: "FN-2", prInfos: [{ number: 2, mergeable: "unknown" }] },
    ]);
    const reclaimSpy = vi.spyOn(manager, "reclaimPrConflictForTask").mockResolvedValue({ outcome: "skipped", reason: "no-conflicting-pr" });

    const reclaimed = await manager.reclaimPrConflicts();

    expect(reclaimSpy).not.toHaveBeenCalled();
    expect(reclaimed).toBe(0);
  });

  it("runs reclaim for tasks where any linked PR is conflicting", async () => {
    const { manager } = createManager([
      { id: "FN-1", prInfos: [{ number: 10, mergeable: "clean" }, { number: 11, mergeable: "conflicting" }] },
      { id: "FN-2", prInfo: { number: 12, mergeable: "conflicting" } },
    ]);
    const reclaimSpy = vi.spyOn(manager, "reclaimPrConflictForTask")
      .mockResolvedValueOnce({ outcome: "reclaimed" })
      .mockResolvedValueOnce({ outcome: "skipped", reason: "active-session" });

    const reclaimed = await manager.reclaimPrConflicts();

    expect(reclaimSpy).toHaveBeenCalledTimes(2);
    expect(reclaimSpy).toHaveBeenNthCalledWith(1, "FN-1");
    expect(reclaimSpy).toHaveBeenNthCalledWith(2, "FN-2");
    expect(reclaimed).toBe(1);
  });

  it("returns skipped when no conflicting PR is linked", async () => {
    const task = { id: "FN-3", prInfos: [{ number: 31, mergeable: "clean" }] };
    const { manager, store } = createManager([]);
    store.getTask.mockResolvedValue(task);

    const result = await manager.reclaimPrConflictForTask("FN-3");

    expect(result).toEqual({ outcome: "skipped", reason: "no-conflicting-pr" });
  });

  it("includes per-pr outcomes for multiple conflicting PRs", async () => {
    const task = {
      id: "FN-4",
      prInfos: [{ number: 41, mergeable: "conflicting" }, { number: 42, mergeable: "conflicting" }],
    };
    const { manager, store } = createManager([]);
    store.getTask.mockResolvedValue(task);

    const result = await manager.reclaimPrConflictForTask("FN-4");

    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("missing-branch-or-worktree");
    expect(result.perPr).toEqual([
      { number: 41, outcome: "skipped", reason: "missing-branch-or-worktree" },
      { number: 42, outcome: "skipped", reason: "missing-branch-or-worktree" },
    ]);
  });
});
