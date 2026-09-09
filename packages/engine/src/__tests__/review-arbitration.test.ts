import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../execution/reviewer.js", () => ({
  reviewStep: vi.fn(),
}));

import { reviewStep } from "../execution/reviewer.js";
import { appendReviewRemediationSteps as appendReviewRemediationStepsReal } from "../executor/append-review-remediation-steps.js";
import { optionalStepRevisionLogOutcome } from "../executor/optional-step-revision.js";
import { reopenLastStepForRevision } from "../executor/reopen-last-step-for-revision.js";
import { runReviewArbitration } from "../executor/review-arbitration.js";
import { sendTaskBackForFix as sendTaskBackForFixReal } from "../executor/send-task-back-for-fix.js";

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

function trailingArbitrationHarness(initialTask: ReturnType<typeof failedTask>) {
  let live: any = initialTask;
  const scheduleWorkflowRerun = vi.fn();
  const store = {
    getSettings: vi.fn(async () => ({ reviewArbitrationEnabled: true })),
    getTaskWorkflowSelection: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getWorkflowSettingValues: vi.fn(async () => ({})),
    getWorkflowSettingsProjectId: vi.fn(() => undefined),
    getTask: vi.fn(async () => live),
    addTaskComment: vi.fn(async () => undefined),
    logEntry: vi.fn(async (_id: string, action: string, outcome?: string) => {
      live = { ...live, log: [...(live.log ?? []), { timestamp: new Date().toISOString(), action, outcome }] };
    }),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      live = { ...live, ...patch };
      return live;
    }),
    updateTaskAtomic: vi.fn(async (_id: string, callback: (task: any) => any) => {
      const patch = await callback(live);
      if (patch) live = { ...live, ...patch };
      return live;
    }),
    publishReviewRemediationFenced: vi.fn(async (_id: string, compute: (task: any) => any) => {
      const patch = compute(live);
      if (!patch) return { applied: false as const, reason: "refused" as const };
      live = { ...live, ...patch };
      return { applied: true as const, task: live };
    }),
  };
  const sendTaskBackForFix = (...args: any[]) => (sendTaskBackForFixReal as any)({
    store,
    clearCompletedTaskWatchdog: vi.fn(),
    injectWorkflowStepFailureInstructions: vi.fn(async () => undefined),
    reopenLastStepForRevision: (taskId: string, task: any, accounting: any) =>
      reopenLastStepForRevision(store as never, taskId, task, accounting),
    scheduleWorkflowRerun,
    maxWorkflowStepRetries: 3,
  }, ...args);
  return { store, sendTaskBackForFix, scheduleWorkflowRerun, live: () => live };
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
      expect.objectContaining({
        revisionKey: "code-review",
        stepName: "Code Review",
        maxRevisions: 3,
        expectedWorkflowStepId: "code-review",
        expectedReviewEpisodeIdentity: expect.any(String),
        expectedColumn: "in-review",
      }),
    );
  });

  it("passes the selected failed episode and remaining ceiling to named remediation", async () => {
    const task = failedTask() as any;
    vi.mocked(reviewStep).mockResolvedValue({
      review: '{"decision":"UPHOLD_REVIEW","notes":"keep fixing","bindingFindingIds":["finding-1"]}',
    });
    const appendReviewRemediationSteps = vi.fn(async () => "appended" as const);
    const store = {
      getSettings: vi.fn(async () => ({ reviewArbitrationEnabled: true })),
      getTaskWorkflowSelection: vi.fn(async () => ({ workflowId: "builtin:coding-ideas-v2" })),
      getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingValues: vi.fn(async () => ({})),
      getWorkflowSettingsProjectId: vi.fn(() => undefined),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        const patch = await callback(task);
        if (patch) Object.assign(task, patch);
        return task;
      }),
    };

    await expect(runReviewArbitration({
      store,
      getRunContextFor: () => ({ agentId: "executor", runId: "run-1" }),
      sendTaskBackForFix: vi.fn(),
      appendReviewRemediationSteps,
    }, task, "code-review", "Code Review", "feedback", 2, 3)).resolves.toBe("arbitrated");

    expect(appendReviewRemediationSteps).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ nodeId: "code-review", findings: [expect.objectContaining({ id: "finding-1" })] }),
      {
        attemptClaim: expect.objectContaining({
          revisionKey: "code-review",
          stepName: "Code Review",
          maxRevisions: 3,
          expectedWorkflowStepId: "code-review",
          expectedReviewEpisodeIdentity: expect.any(String),
          runContext: { agentId: "executor", runId: "run-1" },
        }),
      },
    );
  });

  it("commits upheld named remediation against the post-adjudication episode", async () => {
    const task = failedTask() as any;
    task.postReviewFixCount = 0;
    let live = task;
    vi.mocked(reviewStep).mockResolvedValue({
      review: '{"decision":"UPHOLD_REVIEW","notes":"keep fixing","bindingFindingIds":["finding-1"]}',
    });
    const sendTaskBackForFix = vi.fn(async () => undefined);
    const store = {
      getSettings: vi.fn(async () => ({ reviewArbitrationEnabled: true })),
      getTaskWorkflowSelection: vi.fn(async () => ({ workflowId: "builtin:coding-ideas-v2" })),
      getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingValues: vi.fn(async () => ({})),
      getWorkflowSettingsProjectId: vi.fn(() => undefined),
      getTask: vi.fn(async () => live),
      logEntry: vi.fn(async () => undefined),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        const patch = await callback(live);
        if (patch) live = { ...live, ...patch };
        return live;
      }),
      publishReviewRemediationFenced: vi.fn(async (_id, compute) => {
        const patch = compute(live);
        if (!patch) return { applied: false as const, reason: "refused" as const };
        live = { ...live, ...patch };
        return { applied: true as const, task: live };
      }),
    };
    const appendReviewRemediationSteps = (current, info, options) => appendReviewRemediationStepsReal({
      store: store as never,
      readTaskArtifact: vi.fn(async () => current.prompt),
      sendTaskBackForFix,
    }, current, info, options);

    await expect(runReviewArbitration({
      store: store as never,
      getRunContextFor: () => ({ agentId: "executor", runId: "run-1" }),
      sendTaskBackForFix,
      appendReviewRemediationSteps,
    }, task, "code-review", "Code Review", "feedback", 0, 3)).resolves.toBe("arbitrated");

    expect(live.steps.some((step) => step.status === "pending" && step.remediation?.gate === "Code Review")).toBe(true);
    expect(live.postReviewFixCount).toBe(1);
    expect(live.log.filter((entry) => entry.action.includes("attempt 1/3"))).toHaveLength(1);
    expect(live.log.at(-1)?.outcome).toContain("Workflow revision key: code-review");
    expect(sendTaskBackForFix).toHaveBeenCalledTimes(1);
  });

  it("atomically charges an arbitration upheld trailing replay before scheduling it", async () => {
    const task = failedTask() as any;
    task.steps = [{ name: "Implement fix", status: "done" }];
    task.currentStep = 0;
    task.postReviewFixCount = 0;
    vi.mocked(reviewStep).mockResolvedValue({
      review: '{"decision":"UPHOLD_REVIEW","notes":"keep fixing","bindingFindingIds":["finding-1"]}',
    });
    const harness = trailingArbitrationHarness(task);

    await expect(runReviewArbitration({
      store: harness.store as never,
      getRunContextFor: () => ({ agentId: "executor", runId: "run-1" }),
      sendTaskBackForFix: harness.sendTaskBackForFix,
    }, task, "code-review", "Code Review", "feedback", 0, 1)).resolves.toBe("arbitrated");

    const live = harness.live();
    expect(live.steps).toEqual([
      { name: "Implement fix", status: "done" },
      { name: "Implement fix", status: "pending" },
    ]);
    expect(live.postReviewFixCount).toBe(1);
    expect(live.log.filter((entry) => entry.action.includes("attempt 1/1"))).toHaveLength(1);
    expect(live.log.find((entry) => entry.action.includes("attempt 1/1"))?.outcome).toContain("Workflow revision key: code-review");
    expect(harness.scheduleWorkflowRerun).toHaveBeenCalledTimes(1);
  });

  it("keeps exhausted trailing arbitration work and accounting unchanged", async () => {
    const task = failedTask() as any;
    task.steps = [{ name: "Implement fix", status: "done" }];
    task.currentStep = 0;
    task.postReviewFixCount = 1;
    task.log = [{
      timestamp: "2026-08-22T00:03:00.000Z",
      action: "Auto-reviving in-review task with failed pre-merge workflow step (attempt 1/1)",
      outcome: optionalStepRevisionLogOutcome("Step: Code Review\nStatus: failed", "code-review"),
    }];
    vi.mocked(reviewStep).mockResolvedValue({
      review: '{"decision":"UPHOLD_REVIEW","notes":"keep fixing","bindingFindingIds":["finding-1"]}',
    });
    const harness = trailingArbitrationHarness(task);
    const stepsBefore = structuredClone(task.steps);
    const logBefore = structuredClone(task.log);

    await expect(runReviewArbitration({
      store: harness.store as never,
      getRunContextFor: () => ({ agentId: "executor", runId: "run-1" }),
      sendTaskBackForFix: harness.sendTaskBackForFix,
    }, task, "code-review", "Code Review", "feedback", 1, 1)).resolves.toBe("declined");

    const live = harness.live();
    expect(live.steps).toEqual(stepsBefore);
    expect(live.log).toEqual(logBefore);
    expect(live.postReviewFixCount).toBe(1);
    expect(harness.scheduleWorkflowRerun).not.toHaveBeenCalled();
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
