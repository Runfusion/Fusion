import { describe, expect, it, vi } from "vitest";

import type {
  ExperimentRunRecordPayload,
  ExperimentSession,
  ExperimentSessionRecord,
} from "@fusion/core";

import type { GitOps } from "../experiment/git-ops.js";
import {
  commitKept,
  ExperimentRevertConflictError,
  revertDiscarded,
} from "../experiment/git-policy.js";

const baseSession: ExperimentSession = {
  id: "EXP-001",
  projectId: "proj",
  name: "session",
  metric: { name: "accuracy", direction: "maximize" },
  status: "active",
  currentSegment: 1,
  maxIterations: 10,
  tags: [],
  bestRunId: undefined,
  keptRunIds: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const baseRunRecord: ExperimentSessionRecord = {
  id: "EXPR-001",
  sessionId: "EXP-001",
  segment: 1,
  seq: 1,
  type: "run",
  payload: { status: "keep", primaryMetric: 0.91, secondaryMetrics: [] },
  createdAt: new Date().toISOString(),
};

const baseRunPayload: ExperimentRunRecordPayload = {
  status: "keep",
  primaryMetric: 0.91,
  secondaryMetrics: [],
};

function createGitMock(): GitOps {
  return {
    head: vi.fn(),
    add: vi.fn(),
    commit: vi.fn(),
    resetHard: vi.fn(),
    stashPush: vi.fn(),
    stashPop: vi.fn(),
    statusPorcelain: vi.fn(),
    mergeBase: vi.fn(),
    branchExists: vi.fn(),
    createBranch: vi.fn(),
    cherryPick: vi.fn(),
    checkout: vi.fn(),
    currentBranch: vi.fn(),
    deleteBranch: vi.fn(),
  };
}

describe("git policy", () => {
  it("commitKept stages and commits with default message", async () => {
    const git = createGitMock();
    vi.mocked(git.commit).mockResolvedValue("abc123");

    const result = await commitKept({
      session: baseSession,
      runRecord: baseRunRecord,
      runPayload: baseRunPayload,
      git,
    });

    expect(git.add).toHaveBeenCalledWith(["-A"]);
    expect(git.commit).toHaveBeenCalledWith(
      "experiment(EXP-001): keep EXPR-001 — accuracy=0.91",
    );
    expect(result).toEqual({ commit: "abc123" });
  });

  it("revertDiscarded without preserved paths only resets", async () => {
    const git = createGitMock();
    vi.mocked(git.statusPorcelain).mockResolvedValue(" M src/file.ts");

    const result = await revertDiscarded({
      session: baseSession,
      git,
      baselineCommit: "base-sha",
    });

    expect(git.stashPush).not.toHaveBeenCalled();
    expect(git.resetHard).toHaveBeenCalledWith("base-sha");
    expect(result).toEqual({ revertedTo: "base-sha", preservedPaths: [] });
  });

  it("revertDiscarded with preserved path stashes then pops", async () => {
    const git = createGitMock();
    vi.mocked(git.statusPorcelain).mockResolvedValue(
      " M autoresearch.jsonl\n M src/file.ts",
    );
    vi.mocked(git.stashPush).mockResolvedValue("stash@{0}");

    await revertDiscarded({
      session: baseSession,
      git,
      baselineCommit: "base-sha",
    });

    expect(git.add).toHaveBeenCalledWith(["autoresearch.jsonl"]);
    expect(git.stashPush).toHaveBeenCalledOnce();
    expect(git.resetHard).toHaveBeenCalledWith("base-sha");
    expect(git.stashPop).toHaveBeenCalledWith("stash@{0}");
  });

  it("rethrow stash pop conflicts as ExperimentRevertConflictError", async () => {
    const git = createGitMock();
    vi.mocked(git.statusPorcelain).mockResolvedValue(" M autoresearch.md");
    vi.mocked(git.stashPush).mockResolvedValue("stash@{1}");
    vi.mocked(git.stashPop).mockRejectedValue(new Error("conflict"));

    await expect(
      revertDiscarded({
        session: baseSession,
        git,
        baselineCommit: "base-sha",
      }),
    ).rejects.toBeInstanceOf(ExperimentRevertConflictError);
  });

  it("does not preserve similarly-named non-matching files", async () => {
    const git = createGitMock();
    vi.mocked(git.statusPorcelain).mockResolvedValue(" M autoresearch.jsonl.bak");

    const result = await revertDiscarded({
      session: baseSession,
      git,
      baselineCommit: "base-sha",
    });

    expect(git.add).not.toHaveBeenCalled();
    expect(result.preservedPaths).toEqual([]);
  });
});
