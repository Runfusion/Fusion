/*
FNXC:WorkflowLifecycleColumns 2026-08-02-11:20 (fleet: the merge path on a renamed board):

THE INVARIANT: the PR-merged transition recognises the board's review and complete lanes, and moves the
card to the complete lane the board declares.

WHY THIS ONE MATTERS MOST IN THE CLUSTER. `applyPrMergedTransition` is what advances a card when a PR is
merged on GitHub. Every one of its guards was a default-lineage literal, and they failed in the SAME
direction: `column === "done"` never matched (so an already-complete card was not skipped) and
`column !== "in-review"` always matched (so a card sitting in review bailed with `wrong-column`). Net
effect on a renamed board: **a PR merged on GitHub never advances its Fusion task.** The operator sees a
merged PR whose card sits in review forever, which reads as a broken webhook rather than a column problem —
so it gets debugged in the wrong place.

The MOVE TARGET is asserted alongside the guards on purpose: converting guards alone would admit the card
and then move it to a column the board does not declare, which is the half-conversion this program keeps
finding. The function reads the row TWICE by design (a merge can land between checks), and both reads plus
the move now share one snapshot.
*/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "../types.js";
import { TaskStore as DurableTaskStore } from "../store.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../__test-utils__/pg-test-harness.js";

import { applyPrMergedTransitionImpl } from "../task-store/merge-queue-ops-2.js";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed",
  nodes: [{ id: "start", kind: "start", column: "backlog" }],
  edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function harness(column: string, ir: WorkflowIr | undefined) {
  const task = {
    id: "FN-1", column, prInfo: { status: "merged", number: 3 }, dependencies: [], steps: [],
  } as unknown as Task;
  const moveTask = vi.fn(async (_id: string, to: string) => ({ ...task, column: to }));
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  let releaseTaskLock = Promise.resolve();
  const moveTaskIf = vi.fn(async (_id: string, to: string, predicate: (live: Task) => boolean | Promise<boolean>, options: unknown) => {
    const previous = releaseTaskLock;
    let release: () => void;
    releaseTaskLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!await predicate(task) || task.column === to) return { task, moved: false };
      const moved = await moveTask(_id, to, options);
      task.column = to;
      return { task: moved, moved: true };
    } finally {
      release!();
    }
  });
  const updateTaskUnlocked = vi.fn(async (_id: string, patch: Partial<Task>) => {
    Object.assign(task, patch);
    return task;
  });

  const store = {
    getTask: vi.fn(async () => task),
    getTaskWorkflowSelection: () => (ir ? selection : undefined),
    getTaskWorkflowSelectionAsync: async () => (ir ? selection : undefined),
    getWorkflowDefinition: async () => (ir ? { ir } : undefined),
    withPlanningLifecycleLock: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    moveTask,
    moveTaskIf,
    updateTaskUnlocked,
    emit: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
  } as unknown as TaskStore;

  return { store, moveTask, moveTaskIf, updateTaskUnlocked };
}

describe("the PR-merged transition follows the board's own lanes", () => {
  it("advances a renamed board's review card to its COMPLETE column", async () => {
    // Pre-fix: bailed with skipped:"wrong-column" because `signoff` !== "in-review".
    const { store, moveTask } = harness("signoff", RENAMED_IR);

    const result = await applyPrMergedTransitionImpl(store, "FN-1");

    expect(result.skipped).toBeUndefined();
    expect(result.moved).toBe(true);
    // The destination, not just the admission: a literal `done` would be a column this board lacks.
    expect(moveTask.mock.calls[0]?.[1]).toBe("shipped");
  });

  it("records authoritative external merge evidence once before completing", async () => {
    const { store, moveTask } = harness("signoff", RENAMED_IR);
    const task = await store.getTask("FN-1");
    task.prInfo = { ...task.prInfo!, mergeCommitSha: "external-sha", mergedAt: "2026-09-29T05:00:00.000Z" };

    await expect(applyPrMergedTransitionImpl(store, "FN-1")).resolves.toEqual({ moved: true });
    expect(store.updateTaskUnlocked).toHaveBeenCalledWith("FN-1", {
      mergeDetails: expect.objectContaining({ mergeConfirmed: true, commitSha: "external-sha", mergedAt: "2026-09-29T05:00:00.000Z", prNumber: 3 }),
    });
    expect(moveTask).toHaveBeenCalledOnce();
  });

  it.each(["pending", "failed"] as const)("persists external landing evidence but preserves a %s pre-merge gate", async (status) => {
    const { store, moveTask } = harness("signoff", RENAMED_IR);
    const task = await store.getTask("FN-1");
    task.workflowStepResults = [{
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      status,
    }];
    moveTask.mockImplementation(async (_id: string, _to: string, options: { skipMergeBlocker?: boolean; bypassGuards?: boolean }) => {
      // Model TaskStore's normal guarded review → complete move: this must remain reachable.
      if (options.skipMergeBlocker || options.bypassGuards !== false) return { ...task, column: "shipped" };
      throw new Error("task has incomplete or failed pre-merge workflow steps");
    });

    await expect(applyPrMergedTransitionImpl(store, "FN-1")).rejects.toThrow("pre-merge workflow steps");

    expect(store.updateTaskUnlocked).toHaveBeenCalledWith("FN-1", {
      mergeDetails: expect.objectContaining({ mergeConfirmed: true, prNumber: 3 }),
    });
    expect(moveTask).toHaveBeenCalledWith("FN-1", "shipped", expect.objectContaining({ bypassGuards: false }));
  });

  it("serializes concurrent merged observations so only one emits completion", async () => {
    const { store, moveTask, updateTaskUnlocked } = harness("signoff", RENAMED_IR);

    const results = await Promise.all([
      applyPrMergedTransitionImpl(store, "FN-1", { agentId: "merger", runId: "run-1" }),
      applyPrMergedTransitionImpl(store, "FN-1", { agentId: "merger", runId: "run-2" }),
    ]);

    expect(results).toEqual([
      { moved: true },
      { moved: false, skipped: "already-done" },
    ]);
    expect(moveTask).toHaveBeenCalledOnce();
    expect(updateTaskUnlocked).toHaveBeenCalledOnce();
    expect(store.emit).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(store.recordRunAuditEvent).toHaveBeenCalledOnce());
  });

  it("skips a card already in the board's complete column as already-done", async () => {
    // Pre-fix: `shipped` !== "done", so this was NOT skipped and the transition ran again.
    const { store, moveTask } = harness("shipped", RENAMED_IR);

    const result = await applyPrMergedTransitionImpl(store, "FN-1");

    expect(result.skipped).toBe("already-done");
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("still refuses a card that is in neither lane", async () => {
    // The paired negative: a card mid-implementation must not be advanced by a merged PR.
    const { store, moveTask } = harness("building", RENAMED_IR);

    const result = await applyPrMergedTransitionImpl(store, "FN-1");

    expect(result.skipped).toBe("wrong-column");
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("behaves identically on the DEFAULT board", async () => {
    // Passes either way by design — the legacy ids ARE this board's lanes. No-change evidence.
    const { store, moveTask } = harness("in-review", undefined);

    const result = await applyPrMergedTransitionImpl(store, "FN-1");

    expect(result.moved).toBe(true);
    expect(moveTask.mock.calls[0]?.[1]).toBe("done");
  });
});

/*
FNXC:ExternalPrReconciliation 2026-09-29-06:24:
Two TaskStore instances model dashboard and engine processes against one project-scoped PostgreSQL
backend. An external merge may be observed by both at once, but the advisory lock permits exactly one
review-to-complete transition, event, and audit record while preserving provider-supplied merge evidence.
*/
pgDescribe("external PR reconciliation across TaskStore processes", () => {
  const harness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_external_pr_reconcile",
    projectId: "project_external_pr_reconcile",
  });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  it("commits one externally merged transition and retains its provider evidence", async () => {
    const dashboardStore = harness.store();
    const engineStore = new DurableTaskStore(harness.rootDir(), undefined, { asyncLayer: harness.layer() });
    await engineStore.init();
    const task = await dashboardStore.createTask({ description: "Externally merged PR" });
    await dashboardStore.updateTask(task.id, { enabledWorkflowSteps: [] });
    await dashboardStore.moveTask(task.id, "in-progress");
    await dashboardStore.moveTask(task.id, "in-review");
    await dashboardStore.updatePrInfo(task.id, {
      url: "https://github.com/runfusion/fusion/pull/9406",
      number: 9406,
      status: "merged",
      title: "External merge",
      headBranch: "fusion/FN-9406",
      baseBranch: "main",
      commentCount: 0,
      mergeCommitSha: "provider-merge-sha",
      mergedAt: "2026-09-29T06:24:00.000Z",
    });

    const dashboardEvents = vi.spyOn(dashboardStore, "emit");
    const engineEvents = vi.spyOn(engineStore, "emit");
    const dashboardAudit = vi.spyOn(dashboardStore, "recordRunAuditEvent");
    const engineAudit = vi.spyOn(engineStore, "recordRunAuditEvent");
    const outcomes = await Promise.all([
      applyPrMergedTransitionImpl(dashboardStore, task.id, { agentId: "dashboard", runId: "external-pr-dashboard" }),
      applyPrMergedTransitionImpl(engineStore, task.id, { agentId: "engine", runId: "external-pr-engine" }),
    ]);

    expect(outcomes.filter((outcome) => outcome.moved)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.moved)).toEqual([{ moved: false, skipped: "already-done" }]);
    expect([...dashboardEvents.mock.calls, ...engineEvents.mock.calls].filter(([event]) => event === "task:merged")).toHaveLength(1);
    const persisted = await dashboardStore.getTask(task.id);
    expect(persisted).toMatchObject({
      column: "done",
      mergeDetails: {
        mergeConfirmed: true,
        commitSha: "provider-merge-sha",
        mergedAt: "2026-09-29T06:24:00.000Z",
        prNumber: 9406,
      },
    });
    await vi.waitFor(() => {
      expect([...dashboardAudit.mock.calls, ...engineAudit.mock.calls]).toHaveLength(1);
    });
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-08-02-14:30 (PR #2733 review — greptile P1, and my comment had contradicted
my code):

A WORKFLOW WITH A REVIEW LANE AND NO COMPLETE LANE REFUSES, rather than moving to an undeclared `done`.

I wrote `?? "done"` under a comment claiming the transition refuses rather than inventing a column. The
reviewer read the code and was right: `moveTask` rejects an unknown column, so the merged card would have been
left in review — the exact failure the conversion exists to prevent, reintroduced by a two-character default.

The distinction this pins is the contract the whole program keeps re-learning:
  - NO lane information (v1 IR, unresolvable store) → the legacy ids ARE the answer.
  - Lanes resolved, complete ABSENT → the board has no completion column; substituting one invents a
    destination, so refuse and make it visible in the return value.

Both halves are asserted, because a fix that refuses in BOTH cases would pass a test written only for the
second and would break every legacy board.
*/
describe("a board with no complete column refuses rather than inventing one", () => {
  const NO_COMPLETE_IR = {
    version: "v2", id: "wf-no-complete", name: "no complete",
    nodes: [{ id: "start", kind: "start", column: "backlog" }],
    edges: [],
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    ],
  } as unknown as WorkflowIr;

  it("skips with no-complete-column instead of moving to an undeclared `done`", async () => {
    const { store, moveTask } = harness("signoff", NO_COMPLETE_IR);

    const result = await applyPrMergedTransitionImpl(store, "FN-1");

    expect(result.skipped).toBe("no-complete-column");
    expect(result.moved).toBe(false);
    // The point: no move was attempted at all, so nothing was written for moveTask to reject.
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("STILL uses the legacy `done` when the workflow has no column vocabulary at all", async () => {
    /*
    The other half of the contract, and the case a blanket refusal would break: a v1 IR (or an unresolvable
    store) has told us nothing, so today's behaviour is correct and the legacy id is the answer.
    */
    const { store, moveTask } = harness("in-review", undefined);

    const result = await applyPrMergedTransitionImpl(store, "FN-1");

    expect(result.moved).toBe(true);
    expect(moveTask.mock.calls[0]?.[1]).toBe("done");
  });
});
