import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStore, mockedCreateFnAgent, mockedExecSync, mockedExistsSync, type Task } from "./merger-test-helpers.js";
import * as mergerModule from "../merger.js";

/*
FNXC:OverlapWaitSynchronization 2026-09-18-01:40:
Reimplemented for FN-332: a successful merge publishes an overlap-wait delivery snapshot for every
task currently waiting on it (captureSingleCommitLandedPaths + TaskStore.publishTaskOverlapDeliveries),
so a waiter's overlap-plan-revalidation pass can decide resume/briefing/revalidate without
re-deriving Git state itself. Gated on the store actually exposing the method, so it is a pure
addition for stores/tests that predate the overlap-wait persistence layer.
*/
describe("aiMergeTask overlap-wait delivery publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any);
  });

  function makeStore(settings: Record<string, unknown> = {}) {
    const store = createMockStore(
      { id: "FN-4646", worktree: "/tmp/root/.worktrees/FN-4646", lineageId: "lineage-4646", summary: "adds shared helper" },
      [{ id: "FN-4646", worktree: "/tmp/root/.worktrees/FN-4646", column: "in-review" } as Task],
    );
    (store.getSettings as any).mockResolvedValue({
      includeTaskIdInCommit: true,
      mergeConflictStrategy: "smart-prefer-main",
      mergeIntegrationWorktree: "cwd-main" as const,
      ...settings,
    });
    (store as unknown as { publishTaskOverlapDeliveries: unknown }).publishTaskOverlapDeliveries = vi.fn(async () => 1);
    return store;
  }

  it("publishes a landed delivery snapshot with per-path status parsed from git", async () => {
    const store = makeStore();
    mockedExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (s === "git rev-parse HEAD" || s.startsWith("git rev-parse HEAD ")) return "mergedsha123";
      if (s.includes("git log")) return "- feat: summary";
      if (s.includes("merge-base")) return Buffer.from("base123");
      if (s.includes("merge --squash")) return Buffer.from("");
      if (s.includes("diff --cached --quiet")) return "1";
      if (s.includes("diff --cached")) return "0";
      if (s.includes("show --shortstat --format= HEAD")) return "2 files changed, 3 insertions(+), 1 deletion(-)";
      if (s.includes("show --name-only --format= \"mergedsha123\"")) return "a.ts\nb.ts\n";
      if (s.includes("--name-status -z \"mergedsha123\"")) return "M\0a.ts\0A\0new.ts\0D\0gone.ts\0R100\0old-name.ts\0new-name.ts\0";
      if (s.includes("branch -d") || s.includes("branch -D") || s.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await mergerModule.aiMergeTask(store, "/tmp/root", "FN-4646");

    const publish = (store as unknown as { publishTaskOverlapDeliveries: ReturnType<typeof vi.fn> }).publishTaskOverlapDeliveries;
    expect(publish).toHaveBeenCalledTimes(1);
    const [blockerTaskId, deliveries] = publish.mock.calls[0]!;
    expect(blockerTaskId).toBe("FN-4646");
    expect(deliveries).toEqual([expect.objectContaining({
      blockerTaskId: "FN-4646",
      blockerLineageId: "lineage-4646",
      repository: ".",
      landedSha: "mergedsha123",
      noOp: false,
      evidence: "merge-details",
      summary: "adds shared helper",
    })]);
    expect(deliveries[0].paths).toEqual([
      { repository: ".", path: "a.ts", status: "modified" },
      { repository: ".", path: "new.ts", status: "added" },
      { repository: ".", path: "gone.ts", status: "deleted" },
      { repository: ".", previousPath: "old-name.ts", path: "new-name.ts", status: "renamed" },
    ]);
  });

  it("does not throw and still completes the merge when the store lacks publishTaskOverlapDeliveries", async () => {
    const store = createMockStore(
      { id: "FN-4646", worktree: "/tmp/root/.worktrees/FN-4646" },
      [{ id: "FN-4646", worktree: "/tmp/root/.worktrees/FN-4646", column: "in-review" } as Task],
    );
    (store.getSettings as any).mockResolvedValue({
      includeTaskIdInCommit: true,
      mergeConflictStrategy: "smart-prefer-main",
      mergeIntegrationWorktree: "cwd-main" as const,
    });
    mockedExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (s === "git rev-parse HEAD" || s.startsWith("git rev-parse HEAD ")) return "mergedsha123";
      if (s.includes("git log")) return "- feat: summary";
      if (s.includes("merge-base")) return Buffer.from("base123");
      if (s.includes("merge --squash")) return Buffer.from("");
      if (s.includes("diff --cached --quiet")) return "1";
      if (s.includes("diff --cached")) return "0";
      if (s.includes("show --shortstat --format= HEAD")) return "1 file changed, 1 insertion(+)";
      if (s.includes("show --name-only --format= \"mergedsha123\"")) return "a.ts\n";
      if (s.includes("branch -d") || s.includes("branch -D") || s.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await expect(mergerModule.aiMergeTask(store, "/tmp/root", "FN-4646")).resolves.not.toThrow();
    const detailsUpdate = (store.updateTask as any).mock.calls.find((call: any[]) => call[1]?.mergeDetails?.commitSha === "mergedsha123");
    expect(detailsUpdate).toBeTruthy();
  });
});
