import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../github.js";
import { formatTaskPlannerPrStatus, resolveTaskPlannerPrStatus } from "../task-planner-pr-status.js";

describe("task planner PR status", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a failed required check and behind-base blocker from one authoritative snapshot", async () => {
    const task = {
      id: "FN-9408",
      prInfo: {
        url: "https://github.com/owner/repo/pull/42", number: 42, status: "open", title: "PR",
        headBranch: "fusion/fn-9408", baseBranch: "main", commentCount: 0,
      },
    };
    const store = {
      getTask: vi.fn().mockResolvedValue(task),
      getSettings: vi.fn().mockResolvedValue({}),
      getRootDir: vi.fn().mockReturnValue("/tmp/no-repository"),
      updatePrInfoByNumber: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(GitHubClient.prototype, "getPrReviewSnapshot").mockResolvedValue({
      decision: "REVIEW_REQUIRED",
      checks: [{ name: "ci/build", required: true, state: "failure" }],
      summary: { blockingReasons: ["required checks not successful: ci/build (failure)", "PR is behind its base branch"] },
      prInfo: { ...task.prInfo, headOid: "checked-sha", mergeable: "behind" },
    } as any);

    const result = await resolveTaskPlannerPrStatus(store as any, "FN-9408");

    expect(result).toMatchObject({
      availability: "fresh", rollup: "failure", reviewDecision: "REVIEW_REQUIRED", mergeable: "behind",
      pr: { number: 42, headSha: "checked-sha" },
      checks: [{ name: "ci/build", required: true, state: "failure" }],
      blockers: ["required checks not successful: ci/build (failure)", "PR is behind its base branch"],
      stale: false,
    });
    expect(formatTaskPlannerPrStatus(result)).toContain("ci/build: failure");
    expect(formatTaskPlannerPrStatus(result)).toContain("behind its base branch");
    expect(store.updatePrInfoByNumber).toHaveBeenCalledWith("FN-9408", 42, expect.objectContaining({ headOid: "checked-sha", checkRollup: "failure" }));
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("does not invent a status for a task without a linked pull request", async () => {
    const result = await resolveTaskPlannerPrStatus({ getTask: vi.fn().mockResolvedValue({ id: "FN-EMPTY" }) } as any, "FN-EMPTY");
    expect(result).toEqual({ availability: "no-linked-pr", checks: [], blockers: [], stale: false });
  });
});
