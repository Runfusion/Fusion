import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore, WorkflowStepResult } from "@fusion/core";

const { recordRunAuditEventMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async () => undefined),
}));
vi.mock("../run-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-audit.js")>();
  return {
    ...actual,
    createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock, git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() })),
  };
});

import { SelfHealingManager } from "../self-healing.js";
import { activeSessionRegistry, executingTaskLock } from "../active-session-registry.js";

/*
FNXC:OrphanedPendingSteps 2026-07-22-16:20 (FN-8492 incident):
An engine restart killed an in-flight pre-merge Code Review session, leaving its
`pending` workflowStepResult with no live session behind it. The merge gate read that as
"incomplete pre-merge workflow steps" and after 3 identical 30-minute stalls the deadlock
disposer parked the task `failed`. These tests pin the sweep that recovers such orphans —
and the liveness veto that keeps it from eating a genuinely live session.

FNXC:OrphanedPendingSteps 2026-07-22-16:35 (review follow-up):
The sweep REWRITES orphans to status:"failed" — it must never delete them. Deleting a
pending review entry silently satisfied the merge gate (an enabled step with no result
does not block) and FN-8492 merged with Code Review skipped. The rewrite keeps the gate
closed and routes re-run/bypass through the failed-pre-merge-steps paths.
*/

function stepResult(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    phase: "pre-merge",
    source: "optional-group",
    status: "passed",
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    ...overrides,
  } as WorkflowStepResult;
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

/*
FNXC:WorkflowResolvedColumns 2026-07-31-17:55:
A board whose implementation lane is `building`. Supplied through `listWorkflowDefinitions`, which is
the ONLY store read `resolveProjectColumnsForRoles` makes — a project-wide async read that works under
PostgreSQL, unlike the sync workflow-SELECTION reader that makes `resolveTaskWorkflowIrSync`-based
conversions inert. Using the async helper here is what makes the conversion real rather than decorative.
*/
const RENAMED_WIP_IR = {
  version: "v2",
  id: "custom:wf",
  nodes: [],
  edges: [],
  columns: [
    { id: "drafting", name: "drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "checking", traits: [{ trait: "merge" }] },
  ],
};

function storeFor(tasks: Task[], workflowIr?: unknown): TaskStore & EventEmitter {
  const tasksById = new Map(tasks.map((entry) => [entry.id, entry]));
  return Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    // Honors limit/offset so the >500-row pagination path is actually exercised.
    listTasks: vi.fn(async (options?: { limit?: number; offset?: number }) => {
      const all = [...tasksById.values()];
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? all.length;
      return all.slice(offset, offset + limit);
    }),
    getTask: vi.fn(async (id: string) => tasksById.get(id)),
    /* Absent → the helper keeps the legacy ids, which is every other case in this file. */
    ...(workflowIr ? { listWorkflowDefinitions: vi.fn(async () => [{ ir: workflowIr }]) } : {}),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const next = { ...tasksById.get(id)!, ...patch } as Task;
      tasksById.set(id, next);
      return next;
    }),
  }) as unknown as TaskStore & EventEmitter;
}

describe("FN-8492: reconcile orphaned pending step results", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    executingTaskLock._clearForTest();
    for (const path of ["/wt/registry-live"]) activeSessionRegistry.unregisterPath(path);
  });

  it("rewrites a dead-session pending result to failed (never deletes) and audits ids/counts only", async () => {
    const stranded = task("FN-1", {
      workflowStepResults: [
        stepResult({ status: "passed", verdict: "APPROVE" }),
        stepResult({ status: "pending", workflowStepId: "code-review", workflowStepName: "Code Review" }),
      ],
    });
    const store = storeFor([stranded]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);
    const recovered = await store.getTask("FN-1");
    // Rewrite-to-failed: same length, gate stays closed via the failed entry.
    expect(recovered?.workflowStepResults).toHaveLength(2);
    expect(recovered?.workflowStepResults?.[0]?.status).toBe("passed");
    expect(recovered?.workflowStepResults?.[1]?.status).toBe("failed");
    expect(recovered?.workflowStepResults?.[1]?.completedAt).toBeTruthy();
    expect(recordRunAuditEventMock).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:reconcile-orphaned-pending-step-results",
      target: "FN-1",
      metadata: expect.objectContaining({ taskId: "FN-1", orphanedCount: 1, resultCount: 2 }),
    }));
  });

  it("vetoes on every leg of the liveness triple: isTaskActive, registry path, executing lock", async () => {
    const viaCallback = task("FN-CB", { workflowStepResults: [stepResult({ status: "pending" })] });
    const viaRegistry = task("FN-REG", { workflowStepResults: [stepResult({ status: "pending" })] });
    const viaLock = task("FN-LOCK", { workflowStepResults: [stepResult({ status: "pending" })] });
    activeSessionRegistry.registerPath("/wt/registry-live", { taskId: "FN-REG", kind: "workflow-step", ownerKey: "test" });
    expect(executingTaskLock.tryClaim("FN-LOCK")).toBe(true);
    const store = storeFor([viaCallback, viaRegistry, viaLock]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      isTaskActive: (id: string) => id === "FN-CB",
    });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(0);
    for (const id of ["FN-CB", "FN-REG", "FN-LOCK"]) {
      expect((await store.getTask(id))?.workflowStepResults?.[0]?.status).toBe("pending");
    }
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
  });

  it("skips user-paused and in-progress rows, and tasks with no pending results", async () => {
    const userPaused = task("FN-PAUSED", {
      userPaused: true,
      paused: true,
      workflowStepResults: [stepResult({ status: "pending" })],
    });
    // Executor-owned: resumeOrphaned re-attaches its session on a deferred timer, so
    // startup liveness is unprovable — the sweep must never judge in-progress rows.
    const inProgress = task("FN-INPROG", {
      column: "in-progress",
      workflowStepResults: [stepResult({ status: "pending" })],
    });
    const complete = task("FN-DONE-STEPS", {
      workflowStepResults: [stepResult({ status: "passed" }), stepResult({ status: "failed" })],
    });
    const noResults = task("FN-NONE");
    const store = storeFor([userPaused, inProgress, complete, noResults]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(0);
    expect((await store.getTask("FN-PAUSED"))?.workflowStepResults?.[0]?.status).toBe("pending");
    expect((await store.getTask("FN-INPROG"))?.workflowStepResults?.[0]?.status).toBe("pending");
    expect((await store.getTask("FN-DONE-STEPS"))?.workflowStepResults).toHaveLength(2);
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
  });

  it("paginates past 500 rows and recovers orphans on every page", async () => {
    const many = Array.from({ length: 502 }, (_, i) =>
      task(`FN-P${i}`, { workflowStepResults: [stepResult({ status: "pending" })] }));
    const store = storeFor(many);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(502);
    expect((await store.getTask("FN-P501"))?.workflowStepResults?.[0]?.status).toBe("failed");
    // Two pages of 500 + the short page signalling the end.
    expect((store.listTasks as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("isolates a per-task updateTask failure: the other orphan is still recovered and counted", async () => {
    const failing = task("FN-FAILS", { workflowStepResults: [stepResult({ status: "pending" })] });
    const healthy = task("FN-OK", { workflowStepResults: [stepResult({ status: "pending" })] });
    const store = storeFor([failing, healthy]);
    const passthrough = (store.updateTask as ReturnType<typeof vi.fn>).getMockImplementation()! as
      (id: string, patch: Partial<Task>) => Promise<Task>;
    (store.updateTask as ReturnType<typeof vi.fn>).mockImplementation(async (id: string, patch: Partial<Task>) => {
      if (id === "FN-FAILS") throw new Error("write refused");
      return passthrough(id, patch);
    });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);
    expect((await store.getTask("FN-OK"))?.workflowStepResults?.[0]?.status).toBe("failed");
    expect(recordRunAuditEventMock).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ target: "FN-OK" }));
  });
});

/*
FNXC:WorkflowReviewGates 2026-07-26-16:05:
The pre-merge review gates now run with the card in `in-review`, so this sweep judges them where it
previously skipped them (it skips `in-progress` rows outright). Because it also runs from PERIODIC
maintenance — in the same live process as an active graph run — a tick landing between the gate's
`pending` lease write and its session-registry registration could stamp a genuinely running gate as
`failed`, closing the merge gate on a healthy task. A within-floor lease (`leaseOwner` + recent
`startedAt`) therefore counts as live, matching the semantics Plan Review already had via
`classifyReviewLease`.

The second case is the one that keeps FN-8492 intact: this must DELAY cleanup by the staleness
floor, not defeat it. A lease past the floor is still rewritten to `failed`.
*/
describe("review-gate lease liveness (in-review gates)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => executingTaskLock._clearForTest());

  const leaseResult = (startedAt: string) => stepResult({
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    status: "pending",
    leaseOwner: "run-abc",
    startedAt,
  });

  it("leaves a code-review gate alone while its lease is still within the staleness floor", async () => {
    const live = task("FN-LEASE-LIVE", {
      workflowStepResults: [leaseResult(new Date(Date.now() - 60_000).toISOString())],
    });
    const store = storeFor([live]);
    const manager = new SelfHealingManager(store, "/repo", {} as never);

    const recovered = await manager.reconcileOrphanedPendingStepResults();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    const after = await store.getTask("FN-LEASE-LIVE");
    expect(after?.workflowStepResults?.[0]?.status).toBe("pending");
  });

  it("still fails a code-review gate whose lease has aged past the floor (FN-8492 preserved)", async () => {
    const stale = task("FN-LEASE-STALE", {
      workflowStepResults: [leaseResult(new Date(Date.now() - 60 * 60_000).toISOString())],
    });
    const store = storeFor([stale]);
    const manager = new SelfHealingManager(store, "/repo", {} as never);

    const recovered = await manager.reconcileOrphanedPendingStepResults();

    expect(recovered).toBe(1);
    const after = await store.getTask("FN-LEASE-STALE");
    expect(after?.workflowStepResults?.[0]?.status).toBe("failed");
  });

  it("still fails an ownerless pending result — no leaseOwner means no lease to honor", async () => {
    const ownerless = task("FN-NO-OWNER", {
      workflowStepResults: [stepResult({
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "pending",
        startedAt: new Date().toISOString(),
      })],
    });
    const store = storeFor([ownerless]);
    const manager = new SelfHealingManager(store, "/repo", {} as never);

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);
    const after = await store.getTask("FN-NO-OWNER");
    expect(after?.workflowStepResults?.[0]?.status).toBe("failed");
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-17:55:
  THE EXECUTOR-OWNED SKIP MUST FOLLOW A RENAMED IMPLEMENTATION LANE.

  This sweep REWRITES `pending` step results to `failed`. It skips implementation-lane rows because
  they are executor-owned and their liveness is unprovable here — a skip that was keyed on the
  `in-progress` literal. On a board whose wip lane is named anything else the skip did not apply, so
  the sweep rewrote a live executor's pending results out from under it, closing the merge gate on a
  step that was still running.

  Both legs are asserted: the page-snapshot guard and the re-read guard. They are separate `continue`s
  and either one alone would let this pass while the other stayed literal.
  */
  it("skips an executor-owned row resting in a RENAMED implementation lane", async () => {
    const live = task("FN-RENAMED-WIP", {
      column: "building",
      workflowStepResults: [stepResult({ status: "pending", startedAt: new Date().toISOString() })],
    });
    const store = storeFor([live], RENAMED_WIP_IR);
    const manager = new SelfHealingManager(store, "/repo", {} as never);

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(0);
    expect((await store.getTask("FN-RENAMED-WIP"))?.workflowStepResults?.[0]?.status).toBe("pending");
  });

  /*
  The paired negative. The conversion widens membership, so it must not turn every lane into a skip:
  a card in the same board's REVIEW lane with a dead session is still an orphan and must still be
  rewritten, or the fix trades one silent failure for another.
  */
  it("still rewrites an orphan in a renamed lane that is NOT the implementation lane", async () => {
    const stranded = task("FN-RENAMED-REVIEW", {
      column: "checking",
      workflowStepResults: [stepResult({ status: "pending", startedAt: new Date().toISOString() })],
    });
    const store = storeFor([stranded], RENAMED_WIP_IR);
    const manager = new SelfHealingManager(store, "/repo", {} as never);

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);
    expect((await store.getTask("FN-RENAMED-REVIEW"))?.workflowStepResults?.[0]?.status).toBe("failed");
  });
});
