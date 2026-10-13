// @vitest-environment node

/*
FNXC:StrandedGateRetry 2026-10-13-05:30 (STAS-299 req 4 + Invariant C):
The dashboard Retry button is the surface an operator reaches for first, and before this change it was
also the most destructive one for a card stranded by self-heal's FN-8492 orphan flip. The route hands
every non-missing-worktree shape to the locked stage-restart planner first, and for a card sitting in a
column its workflow plans in, that planner answers `scope: "plan"` → `needs-replan`: the approved plan,
its PROMPT.md, the step list and the fingerprint all go away. An operator clicking Retry to re-run a
review session instead threw away the plan an agent had already had approved.

The classification and patch are shared core functions (`@fusion/core` —
`packages/core/src/__tests__/stranded-gate-retry.test.ts` proves their semantics for every surface).
What THIS file owns is the route's consumption of them: a stranded card must not reach the destructive
planner at all, and the discharge must be the only write.

In-memory store fake (no DB, no network, no timers — AGENTS.md "Do Not Add Slow Tests").
*/

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const STRANDED_ID = "FN-281";

function strandedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: STRANDED_ID,
    description: "Recover a plan-review card stranded by self-heal",
    dependencies: [],
    column: "todo",
    status: null,
    steps: [
      { id: "step-1", title: "Preflight", status: "done" },
      { id: "step-2", title: "Await the plan-review verdict", status: "pending" },
    ],
    currentStep: 1,
    approvedPlanFingerprint: "7a73aaff",
    worktree: "/tmp/fusion-stranded-worktree",
    branch: `fusion/${STRANDED_ID}`,
    log: [],
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T12:00:00.000Z",
    mergeRetries: 0,
    workflowStepResults: [{
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      phase: "pre-merge",
      source: "optional-group",
      status: "failed",
      reviewKind: "plan",
      startedAt: "2026-09-24T00:16:39.000Z",
      output: "Pending step result had no live session or lease; marked failed by self-healing (FN-8492).",
    }],
    ...overrides,
  } as Task;
}

function createHarness(task: Task) {
  const live = task;
  const appliedPatches: Array<Record<string, unknown>> = [];
  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(async () => live),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => Object.assign(live, patch)),
    /* The route applies the reset through a compare-and-set guard, so the fake must replay it. */
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (current: Task) => Record<string, unknown> | null) => {
      const patch = await mutate(live);
      if (patch) {
        appliedPatches.push(patch);
        Object.assign(live, patch);
      }
      return live;
    }),
    logEntry: vi.fn(async () => live),
    moveTask: vi.fn(async () => live),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    resetTerminalFailureAutoRecoveryBudget: vi.fn(async () => live),
    withPlanningLifecycleLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, store, live, appliedPatches };
}

const postRetry = (app: Parameters<typeof REQUEST>[0], id: string, body?: Record<string, unknown>) =>
  REQUEST(app, "POST", `/api/tasks/${id}/retry`, JSON.stringify(body ?? {}), { "content-type": "application/json" });

describe("POST /tasks/:id/retry for a card stranded behind a verdict-less gate", () => {
  it.each([
    ["the card self-heal re-stamped failed after the lifecycle fix", { status: "failed" as const, error: "1 workflow step result(s) marked failed by self-healing (FN-8492)" }],
    ["the card stranded before that fix, which carried no status", {}],
  ])("discharges the gate in place instead of re-planning — %s", async (_name, overrides) => {
    const { app, store, live, appliedPatches } = createHarness(strandedTask(overrides));

    const res = await postRetry(app, STRANDED_ID);

    expect(res.status).toBe(200);
    // The destructive in-place stage restart never sees this card: it is what would answer
    // `scope: "plan"`, stamp `needs-replan`, and delete PROMPT.md.
    expect(store.updateTaskAtomic).toHaveBeenCalledTimes(1);
    expect(appliedPatches).toHaveLength(1);
    const [patch] = appliedPatches;
    expect(patch).toMatchObject({ status: null, error: null, workflowStepResults: [] });
    // Invariant C: the approved plan, its step list, and the work itself are not inputs to this retry.
    for (const destructive of ["steps", "currentStep", "approvedPlanFingerprint", "planDoc", "worktree", "branch", "baseBranch", "baseCommitSha"]) {
      expect(patch, destructive).not.toHaveProperty(destructive);
    }
    expect(live.column).toBe("todo");
    expect(live.status).toBeNull();
    expect(live.error).toBeNull();
    expect(live.workflowStepResults).toEqual([]);
    expect(live.approvedPlanFingerprint).toBe("7a73aaff");
    expect(live.steps.map((step) => step.status)).toEqual(["done", "pending"]);
    expect(live.worktree).toBe("/tmp/fusion-stranded-worktree");
    // The card is not re-queued: a hold lane is already where a re-queue would put it, and moving it
    // there can park the very run the retry asked for (RUFU-261).
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(STRANDED_ID, expect.stringContaining("gate row(s) discharged in todo"));
  });

  it("leaves a genuine re-plan card in the same column with the stage planner, not the discharge", async () => {
    /*
    The guard must be narrow. A card whose workflow PLANS in this column and whose own status says the
    plan is what needs doing is exactly what the in-place stage restart is for — re-planning it is the
    requested outcome, and the stranded branch must not intercept it.

    This asserts OWNERSHIP rather than the restart's outcome: the mocked store has no publication
    seams, so the planner stops at its raise-publication fence instead of finishing. What matters here
    is that the route asked the planner about the card at all, and that the verdict-less discharge
    never touched it — the opposite of the two cases above, where the planner is skipped and the
    discharge is the only write.
    */
    const { app, live, appliedPatches } = createHarness(strandedTask({
      status: "needs-replan",
      error: null,
      approvedPlanFingerprint: null,
      workflowStepResults: [],
    }));

    const res = await postRetry(app, STRANDED_ID);

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("restart-stage-publishing");
    // The verdict-less discharge is the planner-free branch: its signature is a write that clears the
    // gate rows. Nothing here cleared them, and the card kept the status that asks for a re-plan.
    expect(appliedPatches.some((patch) => "workflowStepResults" in patch)).toBe(false);
    expect(live.status).toBe("needs-replan");
  });
});
