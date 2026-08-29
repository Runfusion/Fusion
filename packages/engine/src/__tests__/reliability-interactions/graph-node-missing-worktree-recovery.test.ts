import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "../executor-test-helpers.js";
import {
  PLAN_REVIEW_PROVIDER_FAILURE_HOLD_VALUE,
  WORKSPACE_PREPARATION_FAILURE_HOLD_VALUE,
} from "../../workflows/workflow-graph-executor.js";
// graphFailureValue was peeled off TaskExecutor into executor/graph-failure-pure.ts (wave 18); use the re-exported free function.
import { TaskExecutor, graphFailureValue } from "../../executor.js";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  mockedExistsSync,
  resetExecutorMocks,
} from "../executor-test-helpers.js";
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
    const value = graphFailureValue({
      visitedNodeIds: ["plan-review", "plan-review::plan-review-step"],
      context: {
        "node:plan-review:value": PLAN_REVIEW_PROVIDER_FAILURE_HOLD_VALUE,
        "node:plan-review-step:value": "exception",
      },
    });
    expect(value).toBe(PLAN_REVIEW_PROVIDER_FAILURE_HOLD_VALUE);
  });

  it("falls back to the unqualified template value when the group has none", () => {
    const value = graphFailureValue({
      visitedNodeIds: ["plan-review::plan-review-step"],
      context: { "node:plan-review-step:value": "exception" },
    });
    expect(value).toBe("exception");
  });

  it("keeps resolving foreach `#` instance ids through the container key", () => {
    const value = graphFailureValue({
      visitedNodeIds: ["steps#0:step-execute"],
      context: { "node:steps:value": "awaiting-user-input" },
    });
    expect(value).toBe("awaiting-user-input");
  });
});

describe("workspace preparation graph failure recovery (FN-120)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockReturnValue("" as any);
  });

  it("uses the environment retry lane instead of the Plan Review provider budget", async () => {
    const initial = makeTask();
    const { store, getLive } = trackingStore(initial);
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as any).handleGraphFailure(initial, planReviewGraphFailure({
      "node:plan-review-step:value": WORKSPACE_PREPARATION_FAILURE_HOLD_VALUE,
      "node:plan-review-step:error": "Workspace repository preparation failed for repo1 during acquire: fatal: not a valid object name: 'main'",
    }));

    // FNXC:WorkspacePreparation 2026-08-21-19:52: Git acquisition uses the durable
    // worktree recovery episode, never graph/provider retry accounting.
    expect(getLive().graphResumeRetryCount).toBeUndefined();
    expect(getLive().worktreeSessionRetryCount).toBe(1);
    expect(store.logEntry.mock.calls.some(([, message]: [string, string]) =>
      message.includes("Workspace preparation recovery") && message.includes("not a valid object name"))).toBe(true);
    expect(store.logEntry.mock.calls.some(([, message]: [string, string]) =>
      message.includes("Plan Review provider failure"))).toBe(false);
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

  it("ignores stale error keys from earlier nodes when a later node failed differently", async () => {
    const initial = makeTask();
    const { store } = trackingStore(initial);
    const executor = new TaskExecutor(store, "/tmp/test");

    const handled = await (executor as any).routeUnusableWorktreeGraphFailureToRecovery(
      initial,
      initial,
      {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["start", "plan-review", "plan-review::plan-review-step", "merge"],
        context: {
          // Earlier, already-handled node error must not misroute the merge failure.
          "node:plan-review-step:error": MISSING_WT_ERROR,
          "node:merge:error": "merge conflict in packages/engine/src/executor.ts",
        },
      },
    );

    expect(handled).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("detects the refusal on foreach `container#N:template` materialized ids", async () => {
    const initial = makeTask();
    const { store, getLive } = trackingStore(initial);
    const executor = new TaskExecutor(store, "/tmp/test");

    const handled = await (executor as any).routeUnusableWorktreeGraphFailureToRecovery(
      initial,
      initial,
      {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["steps#0:step-execute"],
        context: { "node:step-execute:error": MISSING_WT_ERROR },
      },
    );

    expect(handled).toBe(true);
    expect(getLive().column).toBe("todo");
  });

  it("leaves auto-merge-off in-review tasks terminal for human merge (FN-5147)", async () => {
    const initial = makeTask({ column: "in-review" as const, status: "failed" });
    const { store } = trackingStore(initial);
    store.getSettings.mockResolvedValue({ autoMerge: false } as any);
    const executor = new TaskExecutor(store, "/tmp/test");

    const handled = await (executor as any).routeUnusableWorktreeGraphFailureToRecovery(
      initial,
      initial,
      planReviewGraphFailure({ "node:plan-review-step:error": MISSING_WT_ERROR }),
    );

    expect(handled).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith(
      initial.id,
      expect.objectContaining({ worktree: null }),
      expect.anything(),
    );
  });

  it("still recovers in-review tasks when auto-merge processing is allowed", async () => {
    const initial = makeTask({ column: "in-review" as const, status: "failed" });
    const { store, getLive } = trackingStore(initial);
    store.getSettings.mockResolvedValue({ autoMerge: true } as any);
    const executor = new TaskExecutor(store, "/tmp/test");

    const handled = await (executor as any).routeUnusableWorktreeGraphFailureToRecovery(
      initial,
      initial,
      planReviewGraphFailure({ "node:plan-review-step:error": MISSING_WT_ERROR }),
    );

    expect(handled).toBe(true);
    expect(getLive().column).toBe("todo");
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

  /*
  FNXC:NodeWorktreeIsolation 2026-07-25-22:10:
  FN-7996's invariant is unchanged — a missing recorded worktree must never terminal-park Plan Review —
  but the remedy is no longer "run in the shared repo root". Every lane now runs in the TASK's own
  worktree, so the reviewer RE-ACQUIRES one. The assertion below is the same symptom (stale path gone,
  review still runs) with the shared checkout removed as an outcome.
  */
  it("re-acquires a task worktree for Plan Review when the recorded worktree is gone (never the repo root)", async () => {
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
    // Not the stale path, and — the point of the change — not the shared repo root either.
    expect(captured.worktreePath).not.toBe("/tmp/stale-wt");
    expect(captured.worktreePath).not.toBe("/tmp/test");
    expect(captured.worktreePath).toContain("/tmp/test/.worktrees/");
    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("re-acquiring a task worktree instead of running in the shared checkout"),
      undefined,
      undefined,
    );
  });

  it("releases the repo-root session lease after the fallback reviewer completes", async () => {
    const store = createMockStore();
    const agentStore = { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() };
    const executor = new TaskExecutor(store, "/tmp/test", { agentStore } as any);
    const output = '{"verdict":"APPROVE","notes":""}';
    mockedCreateFnAgent.mockImplementation(async () => {
      const listeners: Array<(event: any) => void> = [];
      return {
        session: {
          state: {},
          subscribe: (listener: (event: any) => void) => {
            listeners.push(listener);
            return vi.fn();
          },
          prompt: vi.fn(async () => {
            for (const listener of listeners) {
              listener({
                type: "message_update",
                assistantMessageEvent: {
                  type: "text_delta",
                  contentIndex: 0,
                  delta: output,
                  partial: output,
                },
              });
            }
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const live = makeTask();
    const step = {
      id: "graph:plan-review-step",
      name: "Plan Review",
      description: "",
      mode: "prompt",
      phase: "pre-merge",
      gateMode: "gate",
      prompt: "Review the plan.",
      toolMode: "readonly",
      enabled: true,
      createdAt: live.createdAt,
      updatedAt: live.updatedAt,
    };

    const result = await (executor as any).executeWorkflowStep(live, step, "/tmp/test", {});

    expect(result.success).toBe(true);
    expect(activeSessionRegistry.lookupByPath("/tmp/test")).toBeNull();
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
