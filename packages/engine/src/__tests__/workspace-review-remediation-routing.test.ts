import { describe, expect, it, vi } from "vitest";
import { getBuiltinWorkflow, type Task, type TaskStep } from "@fusion/core";

import { appendReviewRemediationSteps } from "../executor/append-review-remediation-steps.js";
import { requestPreMergeOptionalStepFix } from "../executor/request-pre-merge-optional-step-fix.js";

const PROMPT = [
  "# Task: FN-201",
  "",
  "## File Scope",
  "",
  "- `repo-a/src/x.ts`",
  "",
  "## Steps",
  "",
  "### Step 1: Implement",
].join("\n");

function harness(options: {
  findings?: Array<{ id: string; title: string; body: string; filePath: string; severity?: "critical" }>;
  workflowStepResults?: Task["workflowStepResults"];
  workspaceWorktreePath?: string;
  workspace?: boolean;
} = {}) {
  const findings = options.findings ?? [{
    id: "repo-a:finding-1",
    title: "Missing guard",
    body: "Add the missing concurrency guard.",
    filePath: "repo-a/src/x.ts",
    severity: "critical" as const,
  }];
  const task = {
    id: "FN-201",
    column: "in-review",
    worktree: "/tmp/singular",
    prompt: PROMPT,
    modifiedFiles: ["repo-a/src/x.ts"],
    steps: [{ name: "Implement", status: "done" }] as TaskStep[],
    ...(options.workspace === false ? {} : {
      repositoryScope: { state: "confirmed", revision: 1, repositories: ["repo-a", "repo-b"] },
      workspaceWorktrees: {
        "repo-a": { worktreePath: options.workspaceWorktreePath ?? "/tmp/repo-a", baseCommitSha: "a" },
        "repo-b": { worktreePath: "/tmp/repo-b", baseCommitSha: "b" },
      },
      workflowStepResults: options.workflowStepResults ?? [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        verdict: "REVISE",
        repositoryScopeRevision: 1,
        repositoryReviewOutcomes: [{
          repository: "repo-a",
          status: "REVIEWED",
          verdict: "REVISE",
          findings,
          fingerprint: "fingerprint-a",
          episodeId: "episode-a",
          reviewedAt: "2026-08-27T12:00:00.000Z",
        }],
      }],
    }),
  } as unknown as Task;
  const sendTaskBackForFix = vi.fn(async () => undefined);
  const store = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    logEntry: vi.fn(async () => undefined),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      Object.assign(task, patch);
      return task;
    }),
    appendRemediationSteps: vi.fn(async (_id: string, steps: readonly TaskStep[], options_: { wave?: number }) => {
      const appended = steps.map((step) => ({ ...step, status: "pending" as const }));
      task.steps = [...(task.steps ?? []), ...appended];
      return { task, appended, appendedCount: appended.length, wave: options_.wave ?? 1 };
    }),
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>) => {
      const patch = await mutate(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    updateWorkspaceReviewState: vi.fn(async (_id: string, revision: number, remediation: NonNullable<NonNullable<Task["repositoryScope"]>["reviewRemediation"]>) => {
      if (task.repositoryScope?.revision !== revision) return { task, updated: false };
      task.repositoryScope = { ...task.repositoryScope, reviewRemediation: remediation };
      return { task, updated: true };
    }),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding-ideas-v2" })),
    getWorkflowDefinition: vi.fn(async (id: string) => {
      const workflow = getBuiltinWorkflow(id);
      return workflow ? { ir: workflow.ir } : undefined;
    }),
  };
  const deps = {
    store: store as never,
    getRunContextFor: () => undefined,
    recoverMissingRequiredArtifacts: vi.fn(async () => undefined),
    parkPlanReviewReplanCapExhausted: vi.fn(async () => undefined),
    clearPausedAborted: vi.fn(),
    readTaskArtifact: async () => task.prompt,
    appendReviewRemediationSteps: (live: Task, info: never) => appendReviewRemediationSteps(
      { store: store as never, readTaskArtifact: async () => task.prompt, sendTaskBackForFix },
      live,
      info,
    ),
    workflowLifecycleMovesInFlight: new Set<string>(),
    sendTaskBackForFix,
  };
  return { task, store, deps, sendTaskBackForFix };
}

const reviseInfo = (findings: Array<{ id: string; title: string; body: string; filePath: string; severity?: "critical" }>) => ({
  stepName: "Code Review",
  feedback: "Review requested changes.",
  phase: "pre-merge" as const,
  status: "failed" as const,
  verdict: "REVISE",
  nodeId: "code-review",
  findings,
});

describe("workspace named Code Review remediation routing", () => {
  it("appends qualified work and bounces into the failing repository without persisting a singular worktree", async () => {
    const { task, store, deps, sendTaskBackForFix } = harness();
    const findings = task.workflowStepResults?.[0]?.repositoryReviewOutcomes?.[0]?.findings ?? [];

    const scheduled = await requestPreMergeOptionalStepFix(deps as never, task.id, task, reviseInfo(findings));

    expect(scheduled).toBe(true);
    expect(task.steps?.at(-1)?.remediation).toMatchObject({
      gate: "Code Review",
      filePath: "repo-a/src/x.ts",
      findingId: "repo-a:finding-1",
    });
    expect(sendTaskBackForFix).toHaveBeenCalledWith(
      expect.anything(), "/tmp/repo-a", expect.anything(), expect.anything(), expect.anything(), true, false,
      undefined, findings, false, "none",
    );
    expect(store.updateWorkspaceReviewState).toHaveBeenCalledWith("FN-201", 1, expect.objectContaining({ repository: "repo-a" }));
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-201", expect.objectContaining({ status: "awaiting-approval" }));
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-201", "Review remediation requires human action", "review-remediation-no-actionable-findings");
    expect(task.prompt).toContain("- `repo-a/src/x.ts`");
  });

  it("leaves no remediation steps or prompt edits when a scope CAS reports supersession", async () => {
    const { task, store, deps, sendTaskBackForFix } = harness();
    const findings = task.workflowStepResults?.[0]?.repositoryReviewOutcomes?.[0]?.findings ?? [];
    const originalSteps = [...(task.steps ?? [])];
    const originalPrompt = task.prompt;
    store.updateWorkspaceReviewState.mockImplementationOnce(async () => {
      task.repositoryScope = { ...task.repositoryScope!, revision: 2 };
      return { task, updated: false };
    });

    const scheduled = await requestPreMergeOptionalStepFix(deps as never, task.id, task, reviseInfo(findings));

    expect(scheduled).toBe(false);
    expect(store.appendRemediationSteps).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(task.steps).toEqual(originalSteps);
    expect(task.prompt).toBe(originalPrompt);
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-201", "Workspace review remediation superseded by repository scope change");
  });

  it("does not append stale workspace remediation after a post-CAS scope change", async () => {
    const { task, store, deps, sendTaskBackForFix } = harness();
    const findings = task.workflowStepResults?.[0]?.repositoryReviewOutcomes?.[0]?.findings ?? [];
    const originalSteps = [...(task.steps ?? [])];
    const originalPrompt = task.prompt;
    store.updateWorkspaceReviewState.mockImplementationOnce(async (_id: string, revision: number, remediation: NonNullable<NonNullable<Task["repositoryScope"]>["reviewRemediation"]>) => {
      expect(revision).toBe(1);
      task.repositoryScope = { ...task.repositoryScope!, reviewRemediation: remediation };
      return { task, updated: true };
    });
    store.updateTaskAtomic.mockImplementationOnce(async (_id: string, mutate: (current: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>) => {
      task.repositoryScope = { ...task.repositoryScope!, revision: 2 };
      const patch = await mutate(task);
      if (patch) Object.assign(task, patch);
      return task;
    });

    const scheduled = await requestPreMergeOptionalStepFix(deps as never, task.id, task, reviseInfo(findings));

    expect(scheduled).toBe(false);
    expect(task.steps).toEqual(originalSteps);
    expect(task.prompt).toBe(originalPrompt);
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(store.appendRemediationSteps).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-201", "Workspace review remediation superseded by repository scope change");
  });

  it("honestly parks a finding-less revise instead of inventing work", async () => {
    const { task, store, deps, sendTaskBackForFix } = harness({ findings: [] });

    const scheduled = await requestPreMergeOptionalStepFix(deps as never, task.id, task, reviseInfo([]));

    expect(scheduled).toBe(false);
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-201", "Review remediation requires human action", "review-remediation-no-actionable-findings");
  });

  it("parks qualified findings outside the workspace file scope", async () => {
    const findings = [{ id: "repo-b:finding-1", title: "Outside", body: "Fix outside scope.", filePath: "repo-b/src/outside.ts", severity: "critical" as const }];
    const { task, store, deps, sendTaskBackForFix } = harness({ findings });

    const scheduled = await requestPreMergeOptionalStepFix(deps as never, task.id, task, reviseInfo(findings));

    expect(scheduled).toBe(false);
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-201", "Review remediation requires human action", "review-remediation-upstream-out-of-scope");
  });

  it("parks when the failed repository has no acquired workspace worktree", async () => {
    const { task, store, deps, sendTaskBackForFix } = harness({ workspaceWorktreePath: "" });
    const findings = task.workflowStepResults?.[0]?.repositoryReviewOutcomes?.[0]?.findings ?? [];

    const scheduled = await requestPreMergeOptionalStepFix(deps as never, task.id, task, reviseInfo(findings));

    expect(scheduled).toBe(false);
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-201", "Review remediation requires human action", "review-remediation-workspace-worktree-missing");
  });

  it("retains the singular worktree bounce contract outside workspace mode", async () => {
    const findings = [{ id: "finding-1", title: "Missing", body: "Fix the guard.", filePath: "repo-a/src/x.ts", severity: "critical" as const }];
    const { task, deps, sendTaskBackForFix } = harness({ workspace: false, findings });

    const scheduled = await requestPreMergeOptionalStepFix(deps as never, task.id, task, reviseInfo(findings));

    expect(scheduled).toBe(true);
    expect(sendTaskBackForFix.mock.calls[0]?.[1]).toBe("/tmp/singular");
    expect(sendTaskBackForFix.mock.calls[0]?.[9]).toBeUndefined();
  });
});
