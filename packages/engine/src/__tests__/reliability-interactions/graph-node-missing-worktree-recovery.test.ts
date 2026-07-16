import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "../executor-test-helpers.js";
import { PLAN_REVIEW_PROVIDER_FAILURE_HOLD_VALUE } from "../../workflow-graph-executor.js";
import { TaskExecutor } from "../../executor.js";
import { createMockStore, mockedExecSync, mockedExistsSync, resetExecutorMocks } from "../executor-test-helpers.js";
import { MAX_WORKTREE_SESSION_RETRIES } from "../../self-healing.js";

/*
FNXC:MissingWorktreeRecovery 2026-07-16-18:40:
FN-7996 regression coverage. A session-start unusable-worktree refusal thrown inside a
workflow-graph NODE (Plan Review ran with stale task.worktree metadata pointing at a recycled
worktree) fell through every graph-failure router into the terminal park, erasing the error
signature and looping dispatch→park all day. The invariant: any graph-node failure carrying the
assertValidWorktreeSession refusal routes into the bounded worktree-session recovery (clear
stale metadata, requeue todo) and only an exhausted budget may terminal-park; additionally
graphFailureValue must resolve optional-group materialized ids (`group::template`) so group
routing values (e.g. FN-7977's provider-failure hold) are never invisible.
*/

const MISSING_WT_ERROR = "Refusing to start coding agent in missing worktree: /tmp/stale-wt";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  const now = new Date().toISOString();
  return {
    id: "FN-7996-T",
    title: "Graph node missing worktree",
    description: "Desc",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Preflight", status: "pending" }],
    currentStep: 0,
    log: [],
    worktree: "/tmp/stale-wt",
    branch: "fusion/fn-7996-t",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

function planReviewGraphFailure(context: Record<string, unknown>) {
  return {
    disposition: "failed",
    outcome: "failure" as const,
    visitedNodeIds: ["start", "plan-review", "plan-review::plan-review-step"],
    context,
  };
}

function trackingStore(initial: TaskDetail) {
  const store = createMockStore();
  let live = initial;
  store.getTask.mockImplementation(async () => live as any);
  store.updateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => {
    live = { ...live, ...updates } as TaskDetail;
    return live as any;
  });
  store.moveTask.mockImplementation(async (_id: string, column: string) => {
    live = { ...live, column } as TaskDetail;
  });
  return { store, getLive: () => live };
}

describe("graphFailureValue optional-group materialized ids", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockReturnValue("" as any);
  });

  it("prefers the group's published value for a `group::template` failed node", () => {
    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    const value = (executor as any).graphFailureValue({
      visitedNodeIds: ["plan-review", "plan-review::plan-review-step"],
      context: {
        "node:plan-review:value": PLAN_REVIEW_PROVIDER_FAILURE_HOLD_VALUE,
        "node:plan-review-step:value": "exception",
      },
    });
    expect(value).toBe(PLAN_REVIEW_PROVIDER_FAILURE_HOLD_VALUE);
  });

  it("falls back to the unqualified template value when the group has none", () => {
    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    const value = (executor as any).graphFailureValue({
      visitedNodeIds: ["plan-review::plan-review-step"],
      context: { "node:plan-review-step:value": "exception" },
    });
    expect(value).toBe("exception");
  });

  it("keeps resolving foreach `#` instance ids through the container key", () => {
    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    const value = (executor as any).graphFailureValue({
      visitedNodeIds: ["steps#0:step-execute"],
      context: { "node:steps:value": "awaiting-user-input" },
    });
    expect(value).toBe("awaiting-user-input");
  });
});

describe("graph-node unusable-worktree failure recovery (FN-7996)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockReturnValue("" as any);
  });

  it("requeues to todo with cleared worktree metadata instead of terminal-parking", async () => {
    const initial = makeTask();
    const { store, getLive } = trackingStore(initial);
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as any).handleGraphFailure(initial, planReviewGraphFailure({
      "node:plan-review-step:error": MISSING_WT_ERROR,
      "node:plan-review-step:value": "exception",
    }));

    const live = getLive();
    expect(live.column).toBe("todo");
    expect(live.status).toBeNull();
    expect(live.worktree).toBeNull();
    expect(live.branch).toBeNull();
    expect(live.worktreeSessionRetryCount).toBe(1);
    expect(store.updateTask).not.toHaveBeenCalledWith(
      initial.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(store.moveTask).toHaveBeenCalledWith(
      initial.id,
      "todo",
      expect.objectContaining({ moveSource: "engine", recoveryRehome: true }),
    );
  });

  it("recovers when the refusal is only present under the materialized instance error key", async () => {
    const initial = makeTask();
    const { store, getLive } = trackingStore(initial);
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as any).handleGraphFailure(initial, planReviewGraphFailure({
      "node:plan-review::plan-review-step:error": MISSING_WT_ERROR,
    }));

    expect(getLive().column).toBe("todo");
    expect(getLive().worktree).toBeNull();
  });

  it("terminal-parks visibly once the worktree-session retry budget is exhausted", async () => {
    const initial = makeTask({ worktreeSessionRetryCount: MAX_WORKTREE_SESSION_RETRIES });
    const { store, getLive } = trackingStore(initial);
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as any).handleGraphFailure(initial, planReviewGraphFailure({
      "node:plan-review-step:error": MISSING_WT_ERROR,
    }));

    const live = getLive();
    expect(live.column).toBe("in-progress");
    expect(live.status).toBe("failed");
    expect(String(live.error)).toContain("plan-review::plan-review-step");
    expect(store.moveTask).not.toHaveBeenCalledWith(initial.id, "todo", expect.anything());
  });

  it("does not intercept graph failures without the worktree refusal signature", async () => {
    const initial = makeTask();
    const { store } = trackingStore(initial);
    const executor = new TaskExecutor(store, "/tmp/test");

    const handled = await (executor as any).routeUnusableWorktreeGraphFailureToRecovery(
      initial,
      initial,
      planReviewGraphFailure({ "node:plan-review-step:error": "model API key missing" }),
    );

    expect(handled).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it.each([
    ["paused", { paused: true }],
    ["user-paused", { userPaused: true }],
    ["deleted", { deletedAt: new Date().toISOString() }],
    ["done", { column: "done" as const }],
  ])("leaves %s tasks to their owning machinery", async (_label, overrides) => {
    const initial = makeTask(overrides as Partial<TaskDetail>);
    const { store } = trackingStore(initial);
    const executor = new TaskExecutor(store, "/tmp/test");

    const handled = await (executor as any).routeUnusableWorktreeGraphFailureToRecovery(
      initial,
      initial,
      planReviewGraphFailure({ "node:plan-review-step:error": MISSING_WT_ERROR }),
    );

    expect(handled).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});

describe("Plan Review missing-worktree repo-root fallback (FN-7996)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockReturnValue("" as any);
  });

  it("runs the Plan Review reviewer from the repo root when the recorded worktree is gone", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    mockedExistsSync.mockImplementation((path: unknown) => path !== "/tmp/stale-wt");

    const captured: { worktreePath?: string } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      return { success: true, output: "APPROVE" };
    });

    const node = {
      id: "plan-review-step",
      kind: "prompt",
      config: { name: "Plan Review", prompt: "Review the plan." },
    };
    const live = makeTask({ worktree: "/tmp/stale-wt" });
    store.getTask.mockResolvedValue(live as any);
    const result = await (executor as any).runGraphCustomNode(node, live, {}, undefined);

    expect(result.outcome).toBe("success");
    expect(captured.worktreePath).toBe("/tmp/test");
    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("running the reviewer from the repo root"),
      undefined,
      undefined,
    );
  });

  it("keeps other read-only nodes on the recorded path so they fail fast into recovery", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    mockedExistsSync.mockImplementation((path: unknown) => path !== "/tmp/stale-wt");

    const captured: { worktreePath?: string } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      return { success: true, output: "ok" };
    });

    const node = {
      id: "custom-gate",
      kind: "prompt",
      config: { name: "Custom Gate", prompt: "Check something.", toolMode: "readonly" },
    };
    const live = makeTask({ worktree: "/tmp/stale-wt" });
    store.getTask.mockResolvedValue(live as any);
    await (executor as any).runGraphCustomNode(node, live, { reviewerInlineFixes: false }, undefined);

    expect(captured.worktreePath).toBe("/tmp/stale-wt");
  });
});
