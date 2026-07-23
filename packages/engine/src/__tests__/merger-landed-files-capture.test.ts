import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchAttributionError, SilentNoOpAttributionMismatchError } from "../execution/branch-attribution.js";
import * as attributionModule from "../execution/branch-attribution.js";
import { createMockStore, mockedCreateFnAgent, mockedExecSync, mockedExistsSync, type Task } from "./merger-test-helpers.js";
import * as mergerModule from "../merger.js";

describe("FN-4646 aiMergeTask landedFiles capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any);
  });

  function makeStore(settings: Record<string, unknown> = {}) {
    const store = createMockStore(
      { id: "FN-4646", worktree: "/tmp/root/.worktrees/FN-4646" },
      [{ id: "FN-4646", worktree: "/tmp/root/.worktrees/FN-4646", column: "in-review" } as Task],
    );
    (store.getSettings as any).mockResolvedValue({
      includeTaskIdInCommit: true,
      mergeConflictStrategy: "smart-prefer-main",
      mergeIntegrationWorktree: "cwd-main" as const,
      ...settings,
    });
    return store;
  }

  it("captures squash landedFiles and overwrites modifiedFiles", async () => {
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
      if (s.includes("branch -d") || s.includes("branch -D") || s.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await mergerModule.aiMergeTask(store, "/tmp/root", "FN-4646");
    const detailsUpdate = (store.updateTask as any).mock.calls.find((call: any[]) => call[1]?.mergeDetails?.commitSha === "mergedsha123");
    expect(detailsUpdate?.[1].mergeDetails.landedFiles).toEqual(["a.ts", "b.ts"]);
    expect(detailsUpdate?.[1].modifiedFiles).toEqual(["a.ts", "b.ts"]);
  });

  it("FN-5052 regression: rebase walking 66 foreign commits attributes only the 1 own commit", async () => {
    const store = makeStore({ directMergeCommitStrategy: "always-rebase" });
    vi.spyOn(attributionModule, "filterFilesToOwnTaskCommits").mockResolvedValue({
      files: ["packages/engine/src/self-healing.ts"],
      foreignCommits: Array.from({ length: 66 }, (_, i) => ({ sha: `foreign-${i}`, subject: `feat(FN-${4000 + i}): foreign`, attributedTaskId: `FN-${4000 + i}` })),
      ownCommitCount: 1,
      ownCommitShas: ["ownsha1"],
      rawDiffFileCount: 67,
      commitAttributions: [],
    });
    mockedExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (s === "git rev-parse HEAD" || s.startsWith("git rev-parse HEAD ")) return "rebasesha123";
      if (s.includes("git log")) return "- feat: summary";
      if (s.includes("merge-base")) return Buffer.from("abc123");
      if (s.includes("rev-parse \"abc123\"")) return "rebasebase123";
      if (s.includes("rev-list --reverse \"rebasebase123..fusion/FN-4646\"")) return "";
      if (s.includes("status --porcelain")) return "";
      if (s.includes("rev-parse --git-path CHERRY_PICK_HEAD")) return ".git/CHERRY_PICK_HEAD";
      if (s.includes("rev-parse --git-path sequencer")) return ".git/sequencer";
      if (s.includes("show --shortstat --format= \"ownsha1\"")) return "1 file changed, 3 insertions(+)";
      if (s.includes("branch -d") || s.includes("branch -D") || s.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await mergerModule.aiMergeTask(store, "/tmp/root", "FN-4646");
    const detailsUpdate = (store.updateTask as any).mock.calls.find((call: any[]) => call[1]?.mergeDetails?.commitSha === "rebasesha123");
    expect(detailsUpdate?.[1].mergeDetails.rebaseBaseSha).toBe("rebasebase123");
    expect(detailsUpdate?.[1].mergeDetails.landedFiles).toEqual(["packages/engine/src/self-healing.ts"]);
    expect(detailsUpdate?.[1].mergeDetails.landedFilesAttributionRestricted).toBe(true);
    expect(detailsUpdate?.[1].modifiedFiles).toEqual(["packages/engine/src/self-healing.ts"]);
  });

  it("FN-5052 short-circuit variant: zero own commits yields empty landed files and keeps modifiedFiles", async () => {
    const store = makeStore({ directMergeCommitStrategy: "always-rebase" });
    vi.spyOn(attributionModule, "filterFilesToOwnTaskCommits").mockResolvedValue({
      files: [],
      foreignCommits: Array.from({ length: 66 }, (_, i) => ({ sha: `foreign-${i}`, subject: `feat(FN-${5000 + i}): foreign`, attributedTaskId: `FN-${5000 + i}` })),
      ownCommitCount: 0,
      ownCommitShas: [],
      rawDiffFileCount: 66,
      commitAttributions: [],
    });
    mockedExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (s === "git rev-parse HEAD" || s.startsWith("git rev-parse HEAD ")) return "rebasesha123";
      if (s.includes("git log")) return "- feat: summary";
      if (s.includes("merge-base")) return Buffer.from("abc123");
      if (s.includes("rev-parse \"abc123\"")) return "rebasebase123";
      if (s.includes("rev-list --reverse \"rebasebase123..fusion/FN-4646\"")) return "";
      if (s.includes("status --porcelain")) return "";
      if (s.includes("rev-parse --git-path CHERRY_PICK_HEAD")) return ".git/CHERRY_PICK_HEAD";
      if (s.includes("rev-parse --git-path sequencer")) return ".git/sequencer";
      if (s.includes("branch -d") || s.includes("branch -D") || s.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await mergerModule.aiMergeTask(store, "/tmp/root", "FN-4646");
    const detailsUpdate = (store.updateTask as any).mock.calls.find((call: any[]) => call[1]?.mergeDetails?.commitSha === "rebasesha123");
    expect(detailsUpdate?.[1].mergeDetails.landedFiles).toEqual([]);
    expect(detailsUpdate?.[1].mergeDetails.noOpVerifiedShortCircuit).toBe(true);
    expect(detailsUpdate?.[1].modifiedFiles).toBeUndefined();
  });

  it.each([
    { sourceOwnCommitCount: 0, expectedNoOp: true },
    { sourceOwnCommitCount: 2, expectedNoOp: false },
  ])("FN-5304: source tip attribution guard (sourceOwnCommitCount=$sourceOwnCommitCount)", async ({ sourceOwnCommitCount, expectedNoOp }) => {
    vi.spyOn(attributionModule, "filterFilesToOwnTaskCommits").mockResolvedValue({
      files: [],
      foreignCommits: [],
      ownCommitCount: 0,
      ownCommitShas: [],
      rawDiffFileCount: 0,
      commitAttributions: [],
    });
    vi.spyOn(attributionModule, "collectOwnTaskCommitsForRange").mockResolvedValue({
      ownCommitCount: sourceOwnCommitCount,
      ownCommitShas: sourceOwnCommitCount > 0 ? ["own1", "own2"] : [],
    });

    const capturePromise = mergerModule.captureRebaseLandedFilesForTask({
      rootDir: "/tmp/root",
      rebaseMergeBaseSha: "base123",
      recordedSha: "recorded123",
      taskId: "FN-5304",
      sourceBranchRef: "fusion/fn-5304",
    });

    if (expectedNoOp) {
      const capture = await capturePromise;
      expect(capture.noOpVerifiedShortCircuit).toBe(true);
      expect(capture.landedFilesAttributionRestricted).toBe(true);
      return;
    }

    await expect(capturePromise).rejects.toMatchObject({
      name: "SilentNoOpAttributionMismatchError",
      taskId: "FN-5304",
      recordedSha: "recorded123",
      rebaseMergeBaseSha: "base123",
      sourceBranchRef: "fusion/fn-5304",
      sourceBranchOwnCommitCount: 2,
      sourceBranchOwnCommitShas: ["own1", "own2"],
    });
  });

  it("FN-5304: source ref unavailable keeps no-op short-circuit and emits skip callback", async () => {
    vi.spyOn(attributionModule, "filterFilesToOwnTaskCommits").mockResolvedValue({
      files: [],
      foreignCommits: [],
      ownCommitCount: 0,
      ownCommitShas: [],
      rawDiffFileCount: 0,
      commitAttributions: [],
    });
    vi.spyOn(attributionModule, "collectOwnTaskCommitsForRange").mockRejectedValue(new Error("missing ref"));
    const onNoOpGuardSkipped = vi.fn();

    const capture = await mergerModule.captureRebaseLandedFilesForTask({
      rootDir: "/tmp/root",
      rebaseMergeBaseSha: "base123",
      recordedSha: "recorded123",
      taskId: "FN-5304",
      sourceBranchRef: "fusion/fn-5304",
      onNoOpGuardSkipped,
    });

    expect(capture.noOpVerifiedShortCircuit).toBe(true);
    expect(onNoOpGuardSkipped).toHaveBeenCalledWith("source-ref-unavailable");
  });

  it("FN-5304: aiMergeTask refuses no-op mismatch and parks task in failed in-review", async () => {
    const store = makeStore({ directMergeCommitStrategy: "always-rebase" });
    vi.spyOn(attributionModule, "filterFilesToOwnTaskCommits").mockResolvedValue({
      files: [],
      foreignCommits: [],
      ownCommitCount: 0,
      ownCommitShas: [],
      rawDiffFileCount: 0,
      commitAttributions: [],
    });
    vi.spyOn(attributionModule, "collectOwnTaskCommitsForRange").mockResolvedValue({ ownCommitCount: 1, ownCommitShas: ["own1"] });
    mockedExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (s === "git rev-parse HEAD" || s.startsWith("git rev-parse HEAD ")) return "rebasesha123";
      if (s.includes("git log")) return "- feat: summary";
      if (s.includes("merge-base")) return Buffer.from("abc123");
      if (s.includes("rev-parse \"abc123\"")) return "rebasebase123";
      if (s.includes("rev-list --reverse \"rebasebase123..fusion/FN-4646\"")) return "";
      if (s.includes("status --porcelain")) return "";
      if (s.includes("rev-parse --git-path CHERRY_PICK_HEAD")) return ".git/CHERRY_PICK_HEAD";
      if (s.includes("rev-parse --git-path sequencer")) return ".git/sequencer";
      if (s.includes("branch -d") || s.includes("branch -D") || s.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await expect(mergerModule.aiMergeTask(store, "/tmp/root", "FN-4646")).rejects.toBeInstanceOf(SilentNoOpAttributionMismatchError);
    expect(store.moveTask).toHaveBeenCalledWith("FN-4646", "in-review", expect.any(Object));
    expect(store.updateTask).toHaveBeenCalledWith("FN-4646", expect.objectContaining({ status: "failed" }));
    const detailsUpdate = (store.updateTask as any).mock.calls.find((call: any[]) => call[1]?.mergeDetails?.noOpVerifiedShortCircuit);
    expect(detailsUpdate).toBeUndefined();
  });

  it("sums shortstat across multiple own commits on rebase", async () => {
    const store = makeStore({ directMergeCommitStrategy: "always-rebase" });
    vi.spyOn(attributionModule, "filterFilesToOwnTaskCommits").mockResolvedValue({
      files: ["a.ts", "b.ts", "c.ts"],
      foreignCommits: [],
      ownCommitCount: 3,
      ownCommitShas: ["ownsha1", "ownsha2", "ownsha3"],
      rawDiffFileCount: 3,
      commitAttributions: [],
    });
    mockedExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (s === "git rev-parse HEAD" || s.startsWith("git rev-parse HEAD ")) return "rebasesha123";
      if (s.includes("git log")) return "- feat: summary";
      if (s.includes("merge-base")) return Buffer.from("abc123");
      if (s.includes("rev-parse \"abc123\"")) return "rebasebase123";
      if (s.includes("rev-list --reverse \"rebasebase123..fusion/FN-4646\"")) return "";
      if (s.includes("status --porcelain")) return "";
      if (s.includes("rev-parse --git-path CHERRY_PICK_HEAD")) return ".git/CHERRY_PICK_HEAD";
      if (s.includes("rev-parse --git-path sequencer")) return ".git/sequencer";
      if (s.includes("show --shortstat --format= \"ownsha1\"")) return "1 file changed, 3 insertions(+), 1 deletion(-)";
      if (s.includes("show --shortstat --format= \"ownsha2\"")) return "2 files changed, 5 insertions(+), 2 deletions(-)";
      if (s.includes("show --shortstat --format= \"ownsha3\"")) return "1 file changed, 2 insertions(+)";
      if (s.includes("branch -d") || s.includes("branch -D") || s.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await mergerModule.aiMergeTask(store, "/tmp/root", "FN-4646");
    const detailsUpdate = (store.updateTask as any).mock.calls.find((call: any[]) => call[1]?.mergeDetails?.commitSha === "rebasesha123");
    expect(detailsUpdate?.[1].mergeDetails.landedFiles).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(detailsUpdate?.[1].mergeDetails.filesChanged).toBe(3);
    expect(detailsUpdate?.[1].mergeDetails.insertions).toBe(10);
    expect(detailsUpdate?.[1].mergeDetails.deletions).toBe(3);
    expect(detailsUpdate?.[1].mergeDetails.landedFilesAttributionRestricted).toBe(true);
  });

  it("falls back to legacy rebase capture when attribution fails", async () => {
    const store = makeStore({ directMergeCommitStrategy: "always-rebase" });
    vi.spyOn(attributionModule, "filterFilesToOwnTaskCommits").mockRejectedValue(new BranchAttributionError("boom"));
    mockedExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (s === "git rev-parse HEAD" || s.startsWith("git rev-parse HEAD ")) return "rebasesha123";
      if (s.includes("git log")) return "- feat: summary";
      if (s.includes("merge-base")) return Buffer.from("abc123");
      if (s.includes("rev-parse \"abc123\"")) return "rebasebase123";
      if (s.includes("rev-list --reverse \"rebasebase123..fusion/FN-4646\"")) return "";
      if (s.includes("status --porcelain")) return "";
      if (s.includes("rev-parse --git-path CHERRY_PICK_HEAD")) return ".git/CHERRY_PICK_HEAD";
      if (s.includes("rev-parse --git-path sequencer")) return ".git/sequencer";
      if (s.includes("diff --name-only \"rebasebase123..rebasesha123\"")) return "c.ts\nd.ts\n";
      if (s.includes("diff --shortstat \"rebasebase123..HEAD\"")) return "2 files changed, 4 insertions(+), 1 deletion(-)";
      if (s.includes("branch -d") || s.includes("branch -D") || s.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await mergerModule.aiMergeTask(store, "/tmp/root", "FN-4646");
    const detailsUpdate = (store.updateTask as any).mock.calls.find((call: any[]) => call[1]?.mergeDetails?.commitSha === "rebasesha123");
    expect(detailsUpdate?.[1].mergeDetails.landedFiles).toEqual(["c.ts", "d.ts"]);
    expect(detailsUpdate?.[1].mergeDetails.landedFilesCaptureFallback).toBe("attribution-failed");
  });

  it("skips landedFiles capture for mergeWasEmpty", async () => {
    const store = makeStore();
    mockedExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (s === "git rev-parse HEAD" || s.startsWith("git rev-parse HEAD ")) return "mergedsha123";
      if (s.includes("git log")) return "- feat: summary";
      if (s.includes("merge-base")) return Buffer.from("base123");
      if (s.includes("merge --squash")) return Buffer.from("");
      if (s.includes("diff --cached --quiet")) return "0";
      if (s.includes("show --shortstat --format= HEAD")) return "2 files changed, 3 insertions(+), 1 deletion(-)";
      if (s.includes("branch -d") || s.includes("branch -D") || s.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await mergerModule.aiMergeTask(store, "/tmp/root", "FN-4646");
    const detailsUpdate = (store.updateTask as any).mock.calls.find((call: any[]) => call[1]?.mergeDetails);
    expect(detailsUpdate?.[1].mergeDetails.commitSha).toBeUndefined();
    expect(detailsUpdate?.[1].mergeDetails.landedFiles).toBeUndefined();
    expect(detailsUpdate?.[1].modifiedFiles).toBeUndefined();
  });
});
