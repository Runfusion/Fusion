import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../execution/reviewer.js", () => ({
  reviewStep: vi.fn(),
}));

import { reviewStep } from "../execution/reviewer.js";
import { runReviewArbitration } from "../executor/review-arbitration.js";

function failedTask() {
  return {
    id: "FN-149", title: "Review convergence", description: "", column: "in-review", dependencies: [], steps: [], currentStep: 0,
    log: [], prompt: "# Task", worktree: "/tmp/review", createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
    workflowStepResults: [{
      workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge", source: "optional-group", status: "failed", reviewKind: "code",
      verdict: "REVISE", reviewInputFingerprint: "first", startedAt: "2026-08-22T00:00:00.000Z", completedAt: "2026-08-22T00:01:00.000Z",
      findings: [{ id: "finding-1", title: "Needs change", body: "Fix it", disputedAt: "2026-08-22T00:01:00.000Z" }],
    }],
  };
}

/*
FNXC:ReviewConvergence 2026-08-22-06:06:
FN-149 fences every arbitration disposition, not only an implementer release. A review-upheld
arbiter response for a replaced attempt is stale evidence and must not schedule a bounce that
injects obligations from the review it never examined.
*/
describe("review arbitration fence", () => {
  beforeEach(() => {
    vi.mocked(reviewStep).mockReset();
  });
  it("declines a stale uphold ruling without dispatching remediation", async () => {
    const task = failedTask();
    vi.mocked(reviewStep).mockResolvedValue({
      review: '{"decision":"UPHOLD_REVIEW","notes":"keep fixing","bindingFindingIds":["finding-1"]}',
    });
    const sendTaskBackForFix = vi.fn();
    const store = {
      getSettings: vi.fn(async () => ({ reviewArbitrationEnabled: true })),
      getTaskWorkflowSelection: vi.fn(async () => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingValues: vi.fn(async () => ({})),
      getWorkflowSettingsProjectId: vi.fn(() => undefined),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        task.workflowStepResults[0] = {
          ...task.workflowStepResults[0],
          completedAt: "2026-08-22T00:02:00.000Z",
          reviewInputFingerprint: "newer",
        };
        const patch = await callback(task);
        if (patch) Object.assign(task, patch);
        return task;
      }),
    };

    await expect(runReviewArbitration({ store, getRunContextFor: () => undefined, sendTaskBackForFix }, task, "code-review", "Code Review", "feedback", 2, 3)).resolves.toBe("declined");
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(task.workflowStepResults[0]).toMatchObject({ completedAt: "2026-08-22T00:02:00.000Z", reviewInputFingerprint: "newer" });
  });

  it("reads and bounces an upheld workspace review from the failing repository checkout", async () => {
    const task = failedTask() as any;
    task.worktree = undefined;
    task.repositoryScope = { state: "confirmed", revision: 1, repositories: ["repo1", "repo2"] };
    task.workspaceWorktrees = {
      repo1: { worktreePath: "/tmp/mult-029/repo1", baseCommitSha: "r1" },
      repo2: { worktreePath: "/tmp/mult-029/repo2", baseCommitSha: "r2" },
    };
    task.workflowStepResults[0] = {
      ...task.workflowStepResults[0],
      repositoryScopeRevision: 1,
      repositoryReviewOutcomes: [{
        repository: "repo2",
        status: "REVIEWED",
        verdict: "REVISE",
        findings: [{ ...task.workflowStepResults[0].findings[0], severity: "critical", resolution: "open", filePath: "repo2/tests/test_txt_absence.sh" }],
      }],
    };
    vi.mocked(reviewStep).mockResolvedValue({
      review: '{"decision":"UPHOLD_REVIEW","notes":"keep fixing","bindingFindingIds":["finding-1"]}',
    });
    const sendTaskBackForFix = vi.fn(async () => undefined);
    const store = {
      getSettings: vi.fn(async () => ({ reviewArbitrationEnabled: true })),
      getTaskWorkflowSelection: vi.fn(async () => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingValues: vi.fn(async () => ({})),
      getWorkflowSettingsProjectId: vi.fn(() => undefined),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        const patch = await callback(task);
        if (patch) Object.assign(task, patch);
        return task;
      }),
    };

    await expect(runReviewArbitration({ store, getRunContextFor: () => undefined, sendTaskBackForFix }, task, "code-review", "Code Review", "feedback", 2, 3)).resolves.toBe("arbitrated");

    expect(reviewStep).toHaveBeenCalledWith(
      "/tmp/mult-029/repo2",
      task.id,
      expect.anything(),
      expect.anything(),
      "code",
      expect.anything(),
      undefined,
      expect.anything(),
    );
    expect(sendTaskBackForFix).toHaveBeenCalledWith(
      task,
      "/tmp/mult-029/repo2",
      "feedback",
      "Code Review",
      expect.anything(),
      true,
      false,
      { attempt: 3, max: 3 },
      [expect.objectContaining({ id: "finding-1" })],
      false,
      "reopen-trailing",
    );
  });

  it("retains the process cwd arbitration fallback when no checkout is resolvable", async () => {
    const task = failedTask() as any;
    task.worktree = undefined;
    vi.mocked(reviewStep).mockResolvedValue({
      review: '{"decision":"UPHOLD_IMPLEMENTER","notes":"release","bindingFindingIds":[]}',
    });
    const store = {
      getSettings: vi.fn(async () => ({ reviewArbitrationEnabled: true })),
      getTaskWorkflowSelection: vi.fn(async () => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingValues: vi.fn(async () => ({})),
      getWorkflowSettingsProjectId: vi.fn(() => undefined),
      updateTaskAtomic: vi.fn(async () => task),
    };

    await runReviewArbitration({ store, getRunContextFor: () => undefined, sendTaskBackForFix: vi.fn() }, task, "code-review", "Code Review", "feedback", 2, 3);

    expect(reviewStep).toHaveBeenCalledWith(
      process.cwd(),
      task.id,
      expect.anything(),
      expect.anything(),
      "code",
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });
});
