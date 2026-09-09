import { describe, expect, it } from "vitest";
import "../builtin-traits.js";
import type { Task, WorkflowStepResult } from "../types.js";
import { MANUAL_RETRY_RESET_COUNTER_KEYS } from "../tasks/manual-retry-reset.js";
import { planTaskColumnRestart } from "../tasks/task-column-restart.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";

const ir: WorkflowIr = {
  version: "v2",
  name: "restart-test",
  columns: [
    { id: "planning", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "review", name: "Review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }] },
    { id: "waiting", name: "Waiting", traits: [] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "plan", kind: "prompt", column: "planning" },
    { id: "execute", kind: "prompt", column: "building" },
    { id: "review-node", kind: "optional-group", column: "review" },
    { id: "post-review", kind: "optional-group", column: "review", config: { phase: "post-merge" } },
    { id: "wait", kind: "prompt", column: "waiting" },
  ],
  edges: [],
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-204",
    description: "restart",
    column: "planning",
    dependencies: [],
    steps: [],
    currentStep: 0,
    ...overrides,
  } as Task;
}

function plan(
  overrides: Partial<Task> = {},
  entryColumn = overrides.column ?? "planning",
  workflowIr: WorkflowIr | undefined = ir,
) {
  return planTaskColumnRestart({
    task: task(overrides),
    ir: workflowIr,
    entryNode: { id: "entry", column: entryColumn },
    now: "2026-08-28T00:00:00.000Z",
  });
}

const workspaceStates = {
  one: {
    api: {
      worktreePath: "/worktrees/api",
      branch: "fusion/fn-204-api",
      baseCommitSha: "base-api",
    },
  },
  several: {
    api: {
      worktreePath: "/worktrees/api",
      branch: "fusion/fn-204-api",
      baseCommitSha: "base-api",
      landedSha: "landed-api",
    },
    web: {
      worktreePath: "/worktrees/web",
      branch: "fusion/fn-204-web",
      baseCommitSha: "base-web",
      landFailure: {
        category: "content-conflict" as const,
        message: "Repository could not be landed",
        at: "2026-08-28T00:00:00.000Z",
        branch: "fusion/fn-204-web",
      },
    },
  },
};

const scopeCases = [
  { scope: "plan", column: "planning", stepId: "plan" },
  { scope: "implementation", column: "building", stepId: "execute" },
  { scope: "review", column: "review", stepId: "review-node" },
  { scope: "generic", column: "waiting", stepId: "wait" },
] as const;

describe("planTaskColumnRestart", () => {
  it("replans an intake/hold column without clearing implementation pointers", () => {
    const result = plan({ worktree: "/worktree", steps: [{ description: "old", status: "done" }] });
    expect(result).toMatchObject({ kind: "restart", scope: "plan", deletePrompt: true, entryNodeId: "entry" });
    if (result.kind !== "restart") return;
    expect(result.patch).toMatchObject({ status: "needs-replan", steps: [], currentStep: 0 });
    expect("worktree" in result.patch).toBe(false);
  });

  it("restarts implementation while preserving its plan", () => {
    const result = plan({ column: "building", worktree: "/worktree", branch: "fusion/fn-204", steps: [{ description: "build", status: "done" }] }, "building");
    expect(result).toMatchObject({ kind: "restart", scope: "implementation", releaseSymbolLocks: true });
    if (result.kind !== "restart") return;
    expect(result.patch).toMatchObject({ currentStep: 0, worktree: null, branch: null, branchWriteOrigin: "engine" });
    expect(result.patch.steps?.map((step) => step.status)).toEqual(["pending"]);
  });

  it("restarts review without clearing completed implementation", () => {
    const result = plan({ column: "review", worktree: "/worktree", steps: [{ description: "build", status: "done" }] }, "review");
    expect(result).toMatchObject({ kind: "restart", scope: "review" });
    if (result.kind !== "restart") return;
    expect(result.patch.review).toBeNull();
    expect(result.patch.aiMergeReviewReconciliation).toBeNull();
    expect("steps" in result.patch).toBe(false);
    expect("worktree" in result.patch).toBe(false);
  });

  it.each(Object.entries(workspaceStates))(
    "matches single-repository restart plans in every scope with %s workspace entries",
    (_name, workspaceWorktrees) => {
      for (const { scope, column, stepId } of scopeCases) {
        const workflowStepResults = [{ workflowStepId: stepId, status: "failed" }] as WorkflowStepResult[];
        const shared = { column, workflowStepResults, steps: [{ description: "build", status: "done" as const }] };
        const workspaceTask = task({ ...shared, workspaceWorktrees });
        const workspaceBefore = structuredClone(workspaceTask.workspaceWorktrees);
        const workspaceResult = planTaskColumnRestart({
          task: workspaceTask,
          ir,
          entryNode: { id: "entry", column },
          now: "2026-08-28T00:00:00.000Z",
        });
        const singleResult = plan(shared, column);

        expect(workspaceResult).toMatchObject({
          kind: "restart",
          scope,
          entryNodeId: "entry",
          discardedWorkflowStepIds: [stepId],
        });
        expect(singleResult).toMatchObject({
          kind: "restart",
          scope,
          entryNodeId: "entry",
          discardedWorkflowStepIds: [stepId],
        });
        if (workspaceResult.kind !== "restart" || singleResult.kind !== "restart") continue;
        expect(workspaceResult.scope).toBe(singleResult.scope);
        expect(workspaceResult.entryNodeId).toBe(singleResult.entryNodeId);
        expect(workspaceResult.discardedWorkflowStepIds).toEqual(singleResult.discardedWorkflowStepIds);
        expect("workspaceWorktrees" in workspaceResult.patch).toBe(false);
        expect(workspaceTask.workspaceWorktrees).toEqual(workspaceBefore);
      }
    },
  );

  it("treats an empty workspace map exactly like an absent map", () => {
    for (const { column } of scopeCases) {
      const empty = plan({ column, workspaceWorktrees: {} }, column);
      const absent = plan({ column }, column);
      expect(empty).toEqual(absent);
      if (empty.kind === "restart") expect("workspaceWorktrees" in empty.patch).toBe(false);
    }
  });

  it("clears singular implementation aliases without changing workspace repository records", () => {
    const workspaceWorktrees = structuredClone(workspaceStates.several);
    const before = structuredClone(workspaceWorktrees);
    const result = plan({
      column: "building",
      worktree: workspaceWorktrees.api.worktreePath,
      branch: workspaceWorktrees.api.branch,
      workspaceWorktrees,
      steps: [{ description: "build", status: "done" }],
    }, "building");

    expect(result).toMatchObject({ kind: "restart", scope: "implementation" });
    if (result.kind !== "restart") return;
    expect(result.patch).toMatchObject({ worktree: null, branch: null, branchWriteOrigin: "engine" });
    expect("workspaceWorktrees" in result.patch).toBe(false);
    expect(workspaceWorktrees).toEqual(before);
  });

  it("discards only restarted pre-merge results, preserving post-merge evidence and duplicates elsewhere", () => {
    const results = [
      { workflowStepId: "plan", status: "passed" },
      { workflowStepId: "review-node", status: "failed" },
      { workflowStepId: "review-node", status: "pending" },
      { workflowStepId: "execute", status: "passed" },
      { workflowStepId: "post-review", status: "passed", phase: "post-merge" },
    ] as WorkflowStepResult[];
    const result = plan({ column: "review", workflowStepResults: results }, "review");
    if (result.kind !== "restart") throw new Error("expected restart plan");
    expect(result.discardedWorkflowStepIds).toEqual(["review-node", "review-node"]);
    expect(result.patch.workflowStepResults?.map((item) => item.workflowStepId)).toEqual(["plan", "execute", "post-review"]);
  });

  it("drops only failed/pending review orphans", () => {
    const results = ["failed", "pending", "passed", "skipped"].map((status) => ({ workflowStepId: `orphan-${status}`, status })) as WorkflowStepResult[];
    const review = plan({ column: "review", workflowStepResults: results }, "review");
    if (review.kind !== "restart") throw new Error("expected restart plan");
    expect(review.discardedWorkflowStepIds).toEqual(["orphan-failed", "orphan-pending"]);
    expect(review.patch.workflowStepResults?.map((item) => item.workflowStepId)).toEqual(["orphan-passed", "orphan-skipped"]);
    const implementation = plan({ column: "building", workflowStepResults: results }, "building");
    if (implementation.kind !== "restart") throw new Error("expected restart plan");
    expect(implementation.patch.workflowStepResults).toEqual(results);
  });

  it("retains every shape-based refusal for workspace rows", () => {
    const workspace = { workspaceWorktrees: workspaceStates.one };
    expect(plan({ ...workspace, column: "done" }, "done")).toMatchObject({ kind: "refused", reason: "terminal-column" });
    expect(plan({ ...workspace, column: "archive" }, "archive")).toMatchObject({ kind: "refused", reason: "column-not-in-workflow" });
    expect(plan({ ...workspace, column: "missing" }, "missing")).toMatchObject({ kind: "refused", reason: "column-not-in-workflow" });
    expect(plan(workspace, "planning", { version: "v1", name: "legacy", steps: [] })).toMatchObject({ kind: "refused", reason: "no-column-model" });
    const noEntry = plan(workspace, "building");
    expect(noEntry).toMatchObject({ kind: "refused", reason: "no-entry-node-in-column", detail: { resolvedEntryNodeColumn: "building" } });
    expect("patch" in noEntry).toBe(false);
  });

  it("owns no pause lifecycle keys and resets every manual retry counter", () => {
    const result = plan({ paused: true, userPaused: true, pausedReason: "in-review-stall-deadlock" });
    if (result.kind !== "restart") throw new Error("expected restart plan");
    for (const key of MANUAL_RETRY_RESET_COUNTER_KEYS) expect(result.patch[key]).toBe(0);
    expect("paused" in result.patch).toBe(false);
    expect("userPaused" in result.patch).toBe(false);
    expect("pausedReason" in result.patch).toBe(false);
  });
});
