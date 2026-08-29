import { describe, expect, it, vi } from "vitest";
import {
  BranchAttributionError,
  SilentNoOpAttributionMismatchError,
  collectOwnTaskCommitsForRange,
  filterFilesToOwnTaskCommits,
} from "../execution/branch-attribution.js";

describe("FN-5039 branch-attribution", () => {
  it("returns empty attribution for empty range", async () => {
    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });

    const result = await filterFilesToOwnTaskCommits({
      worktreePath: "/tmp/wt",
      baseRef: "base",
      taskId: "FN-5039",
      execAsyncImpl: execMock as never,
    });

    expect(result).toEqual({
      files: [],
      foreignCommits: [],
      ownCommitCount: 0,
      ownCommitShas: [],
      rawDiffFileCount: 0,
      commitAttributions: [],
    });
  });

  it("collects files from own-attributed commits only", async () => {
    const log = [
      "sha-own-1\x00own one\x00body\nFusion-Task-Id: FN-5039\n\x1e",
      "sha-own-2\x00own two\x00body\nFusion-Task-Id: FN-5039\n\x1e",
    ].join("");

    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "a.ts\nb.ts\n" })
      .mockResolvedValueOnce({ stdout: log })
      .mockResolvedValueOnce({ stdout: "a.ts\n" })
      .mockResolvedValueOnce({ stdout: "b.ts\na.ts\n" });

    const result = await filterFilesToOwnTaskCommits({
      worktreePath: "/tmp/wt",
      baseRef: "base",
      taskId: "FN-5039",
      execAsyncImpl: execMock as never,
    });

    expect(result.files).toEqual(["a.ts", "b.ts"]);
    expect(result.ownCommitCount).toBe(2);
    expect(result.foreignCommits).toEqual([]);
    expect(result.rawDiffFileCount).toBe(2);
  });

  it("treats foreign and untrailered commits as foreign", async () => {
    const log = [
      "sha-own\x00own\x00notes\nFusion-Task-Id: FN-5039\n\x1e",
      "sha-foreign\x00foreign\x00notes\nFusion-Task-Id: FN-1111\n\x1e",
      "sha-none\x00none\x00notes without trailer\x1e",
    ].join("");

    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "task.ts\nforeign.ts\nunt.ts\n" })
      .mockResolvedValueOnce({ stdout: log })
      .mockResolvedValueOnce({ stdout: "task.ts\n" });

    const result = await filterFilesToOwnTaskCommits({
      worktreePath: "/tmp/wt",
      baseRef: "base",
      taskId: "FN-5039",
      execAsyncImpl: execMock as never,
    });

    expect(result.files).toEqual(["task.ts"]);
    expect(result.foreignCommits).toEqual([
      { sha: "sha-foreign", subject: "foreign", attributedTaskId: "FN-1111" },
      { sha: "sha-none", subject: "none", attributedTaskId: null },
    ]);
  });

  it("throws BranchAttributionError on malformed git log output", async () => {
    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "x.ts\n" })
      .mockResolvedValueOnce({ stdout: "\x00missing sha\x00body\x1e" });

    await expect(
      filterFilesToOwnTaskCommits({
        worktreePath: "/tmp/wt",
        baseRef: "base",
        taskId: "FN-5039",
        execAsyncImpl: execMock as never,
      }),
    ).rejects.toBeInstanceOf(BranchAttributionError);
  });

  it("FN-5083 hotfix: falls back to conventional-commit subject when trailer is missing", async () => {
    // Commit subjects use feat(FN-5039):, fix(FN-5039):, test(FN-5039): with EMPTY trailers —
    // the exact pattern that stranded FN-5060/FN-5083/FN-5053 in production.
    const log = [
      "sha-a\x00feat(FN-5039): step 2\x00body without trailer\x1e",
      "sha-b\x00fix(FN-5039): step 3 fixup\x00body without trailer\x1e",
      "sha-c\x00test(FN-5039): step 4 coverage\x00body without trailer\x1e",
      "sha-d\x00chore(FN-1111): foreign commit\x00body without trailer\x1e",
    ].join("");

    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "a.ts\nb.ts\nc.ts\nd.ts\n" })
      .mockResolvedValueOnce({ stdout: log })
      .mockResolvedValueOnce({ stdout: "a.ts\n" })
      .mockResolvedValueOnce({ stdout: "b.ts\n" })
      .mockResolvedValueOnce({ stdout: "c.ts\n" });

    const result = await filterFilesToOwnTaskCommits({
      worktreePath: "/tmp/wt",
      baseRef: "base",
      taskId: "FN-5039",
      execAsyncImpl: execMock as never,
    });

    // Three own commits attributed by subject; one foreign attributed by subject.
    expect(result.ownCommitCount).toBe(3);
    expect(result.files).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(result.foreignCommits).toEqual([
      { sha: "sha-d", subject: "chore(FN-1111): foreign commit", attributedTaskId: "FN-1111" },
    ]);
  });

  it("FN-5083 hotfix: accepts bracketed and colon-prefix legacy subject styles", async () => {
    const log = [
      "sha-a\x00[KB-42] legacy bracket style\x00body\x1e",
      "sha-b\x00KB-42: legacy colon style\x00body\x1e",
      "sha-c\x00feat(kb-42): lowercase convention\x00body\x1e",
    ].join("");

    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "a.ts\nb.ts\nc.ts\n" })
      .mockResolvedValueOnce({ stdout: log })
      .mockResolvedValueOnce({ stdout: "a.ts\n" })
      .mockResolvedValueOnce({ stdout: "b.ts\n" })
      .mockResolvedValueOnce({ stdout: "c.ts\n" });

    const result = await filterFilesToOwnTaskCommits({
      worktreePath: "/tmp/wt",
      baseRef: "base",
      taskId: "KB-42",
      execAsyncImpl: execMock as never,
    });

    expect(result.ownCommitCount).toBe(3);
    expect(result.foreignCommits).toEqual([]);
  });

  it("FN-5304: collectOwnTaskCommitsForRange counts only attributable commits", async () => {
    const log = [
      "sha-a\x00fix(FN-5304): one\x00body\x1e",
      "sha-b\x00fix(FN-9999): foreign\x00body\x1e",
      "sha-c\x00chore: none\x00body\x1e",
    ].join("");
    const execMock = vi.fn().mockResolvedValueOnce({ stdout: log });

    const result = await collectOwnTaskCommitsForRange({
      worktreePath: "/tmp/wt",
      rangeRef: "base..fusion/fn-5304",
      taskId: "FN-5304",
      execAsyncImpl: execMock as never,
    });

    expect(result).toEqual({ ownCommitCount: 1, ownCommitShas: ["sha-a"] });
  });

  it("FN-5304: SilentNoOpAttributionMismatchError carries expected metadata", () => {
    const err = new SilentNoOpAttributionMismatchError({
      taskId: "FN-5304",
      recordedSha: "recorded123",
      rebaseMergeBaseSha: "base123",
      sourceBranchRef: "fusion/fn-5304",
      sourceBranchOwnCommitCount: 2,
      sourceBranchOwnCommitShas: ["own1", "own2"],
    });

    expect(err.name).toBe("SilentNoOpAttributionMismatchError");
    expect(err.taskId).toBe("FN-5304");
    expect(err.recordedSha).toBe("recorded123");
    expect(err.rebaseMergeBaseSha).toBe("base123");
    expect(err.sourceBranchRef).toBe("fusion/fn-5304");
    expect(err.sourceBranchOwnCommitCount).toBe(2);
    expect(err.sourceBranchOwnCommitShas).toEqual(["own1", "own2"]);
    expect(err.message).toContain("silent no-op attribution mismatch");
  });

  it("throws BranchAttributionError when git command fails", async () => {
    const execMock = vi.fn().mockRejectedValueOnce(new Error("fatal: bad revision"));

    await expect(
      filterFilesToOwnTaskCommits({
        worktreePath: "/tmp/wt",
        baseRef: "bad",
        taskId: "FN-5039",
        execAsyncImpl: execMock as never,
      }),
    ).rejects.toBeInstanceOf(BranchAttributionError);
  });
});
