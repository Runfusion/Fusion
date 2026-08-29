import { describe, expect, it, vi } from "vitest";

import { GitHubClient, PrAutoMergeUnavailableError } from "../github.js";
import { mergeTaskPr, resolvePrMergeMethod } from "../routes/register-git-github.js";

const prInfo = {
  number: 8,
  url: "https://github.com/o/r/pull/8",
  status: "open" as const,
  title: "PR",
  headBranch: "fusion/fn-8",
  baseBranch: "main",
  commentCount: 0,
};

function store(settings: Record<string, unknown> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue(settings),
    getRootDir: vi.fn().mockReturnValue("/repo"),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    applyPrMergedTransition: vi.fn().mockResolvedValue(undefined),
  };
}

function mockClient(mergeResult: typeof prInfo | Error, mergeReady = true) {
  vi.spyOn(GitHubClient.prototype, "getPrMergeStatus").mockResolvedValue({
    prInfo: { ...prInfo, headOid: "checked-head", mergeable: "clean" },
    mergeReady,
    blockingReasons: [],
    checks: [],
    reviewDecision: "APPROVED",
    mergeable: "clean",
  } as never);
  if (mergeResult instanceof Error) vi.spyOn(GitHubClient.prototype, "mergePr").mockRejectedValue(mergeResult);
  else vi.spyOn(GitHubClient.prototype, "mergePr").mockResolvedValue(mergeResult as never);
  return GitHubClient;
}

describe("resolvePrMergeMethod", () => {
  it("prefers explicit request method", () => {
    expect(resolvePrMergeMethod({ directMergeCommitStrategy: "always-rebase" }, { autoMergeStrategy: "squash" }, "merge")).toBe("merge");
  });

  it("falls back to pr auto strategy", () => {
    expect(resolvePrMergeMethod({ directMergeCommitStrategy: "always-rebase" }, { autoMergeStrategy: "squash" })).toBe("squash");
  });

  it("maps settings strategy", () => {
    expect(resolvePrMergeMethod({ directMergeCommitStrategy: "always-rebase" }, null)).toBe("rebase");
    expect(resolvePrMergeMethod({ directMergeCommitStrategy: "always-squash" }, null)).toBe("squash");
    expect(resolvePrMergeMethod({ directMergeCommitStrategy: "auto" }, null)).toBe("squash");
  });

  it("hard-falls back to squash", () => {
    expect(resolvePrMergeMethod(undefined, undefined)).toBe("squash");
  });
});

describe("mergeTaskPr native auto-merge", () => {
  afterEach(() => vi.restoreAllMocks());

  it("arms native auto-merge and retains an open PR for background reconciliation", async () => {
    const scopedStore = store({ githubNativeAutoMerge: true });
    const GitHubClient = mockClient(prInfo, false);

    const result = await mergeTaskPr(scopedStore as never, { id: "FN-8", prInfo } as never, undefined);

    expect(result.status).toBe("open");
    expect(GitHubClient.prototype.mergePr).toHaveBeenCalledWith(expect.objectContaining({ auto: true }));
    expect(GitHubClient.prototype.mergePr).not.toHaveBeenCalledWith(expect.objectContaining({ expectedHeadOid: expect.anything() }));
    expect(scopedStore.updatePrInfo).toHaveBeenCalledWith("FN-8", expect.objectContaining({ status: "open", lastMergeError: undefined }));
    expect(scopedStore.applyPrMergedTransition).not.toHaveBeenCalled();
  });

  it("transitions only when GitHub already reports the PR merged", async () => {
    const scopedStore = store({ githubNativeAutoMerge: true });
    mockClient({ ...prInfo, status: "merged" });

    await mergeTaskPr(scopedStore as never, { id: "FN-8", prInfo } as never, undefined);

    expect(scopedStore.applyPrMergedTransition).toHaveBeenCalledWith("FN-8", expect.any(Object));
  });

  it("preserves direct merge fencing when the setting is disabled", async () => {
    const scopedStore = store();
    const GitHubClient = mockClient({ ...prInfo, status: "merged" });

    await mergeTaskPr(scopedStore as never, { id: "FN-8", prInfo } as never, undefined);

    expect(GitHubClient.prototype.mergePr).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadOid: "checked-head" }));
    expect(GitHubClient.prototype.mergePr).not.toHaveBeenCalledWith(expect.objectContaining({ auto: true }));
  });

  it("records an unavailable native auto-merge error without transitioning", async () => {
    const scopedStore = store({ githubNativeAutoMerge: true });
    mockClient(new PrAutoMergeUnavailableError("auto merge disabled"));

    await expect(mergeTaskPr(scopedStore as never, { id: "FN-8", prInfo } as never, undefined)).rejects.toMatchObject({ message: "auto merge disabled" });

    expect(scopedStore.updatePrInfo).toHaveBeenCalledWith("FN-8", expect.objectContaining({ lastMergeError: "auto merge disabled" }));
    expect(scopedStore.applyPrMergedTransition).not.toHaveBeenCalled();
  });
});
