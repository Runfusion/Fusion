import { afterEach, describe, expect, it, vi } from "vitest";
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
      getRootDir: vi.fn().mockReturnValue("/tmp/no-repository"),
      getPrEntityByNumber: vi.fn().mockResolvedValue({
        headOid: "checked-sha",
        readiness: {
          observedHeadOid: "checked-sha", headBehindBase: true,
          requiredChecks: [{ name: "ci/build", state: "failure" }],
          approval: "review-required", mergeable: "behind", state: "open",
          protectionBlockers: ["required checks not successful: ci/build (failure)", "PR is behind its base branch"],
          deployments: { state: "unsupported" }, branchUpdate: { state: "unsupported" },
          checks: { state: "supported" }, reviews: { state: "supported" }, merge: { state: "supported" },
          observedAt: "2026-10-04T23:13:00.000Z",
        },
      }),
    };

    const result = await resolveTaskPlannerPrStatus(store as any, "FN-9408");

    expect(result).toMatchObject({
      availability: "fresh", rollup: "failure", reviewDecision: "REVIEW_REQUIRED", mergeable: "behind",
      pr: { number: 42, headSha: "checked-sha" },
      checks: [{ name: "ci/build", required: true, state: "failure" }],
      blockers: expect.arrayContaining(["required checks not successful: ci/build (failure)", "PR is behind its base branch", "capability unsupported"]),
      stale: false,
    });
    expect(formatTaskPlannerPrStatus(result)).toContain("ci/build: failure");
    expect(formatTaskPlannerPrStatus(result)).toContain("behind its base branch");
    expect(store.getPrEntityByNumber).toHaveBeenCalledWith("owner/repo", 42);
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("does not invent a status for a task without a linked pull request", async () => {
    const result = await resolveTaskPlannerPrStatus({ getTask: vi.fn().mockResolvedValue({ id: "FN-EMPTY" }) } as any, "FN-EMPTY");
    expect(result).toEqual({ availability: "no-linked-pr", checks: [], blockers: [], stale: false });
  });
});
