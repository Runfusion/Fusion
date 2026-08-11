import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

const { recordRunAuditEventMock, resolveTaskLifecycleColumnsMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async () => undefined),
  resolveTaskLifecycleColumnsMock: vi.fn(),
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveTaskLifecycleColumns: resolveTaskLifecycleColumnsMock,
}));
vi.mock("../util/run-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/run-audit.js")>()),
  createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock })),
}));

import { SelfHealingManager } from "../self-healing.js";
import { evaluateStrandedContinuationReclaim } from "../workflows/stranded-continuation-reclaim.js";

/*
FNXC:StrandedContinuationReclaim 2026-08-11-09:12:
The observed incident: the scheduler's due-poll takes only `runnable`/`retrying`, so a continuation that
stops in `running` or `held` is never re-examined by anything. Nine live cards on the Fusion board were
stranded that way — seven `running` behind leases whose process exited ~9h earlier (NULL `leaseExpiresAt`,
so they never aged out) and two `held` with a NULL `blockedReason` for 46h (the claim predicate only
re-takes `workflow-principal-%`/`workflow-named-principal-%`/`workflow-role-pool-%` holds). A further 33
rows in active states belonged to tasks that were archived AND soft-deleted, the oldest a month prior:
the FK cascade only fires on a hard delete.

Surface enumeration — the invariant is asserted across every state the wedge can wear, not just the
reported one: `running` with a NULL lease, `running` with an EXPIRED lease, `held` with a NULL reason,
`held` with a principal-routing reason, a retired task's row in each active state, and the negative
cases (live session, unexpired lease, operator pause, manual-hold kind, engine pause, too-fresh).
*/

const stale = (ms: number) => new Date(Date.now() - ms).toISOString();
const GRACE_EXCEEDED = 20 * 60_000;

function item(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: "wi-1", runId: "run-1", taskId: "FN-8932", nodeId: "plan-review", kind: "task",
    state: "running", attempt: 0, retryAfter: null,
    leaseOwner: "executor:FN-8932", leaseExpiresAt: null, lastError: null, blockedReason: null,
    createdAt: stale(GRACE_EXCEEDED), updatedAt: stale(GRACE_EXCEEDED),
    ...overrides,
  } as unknown as WorkflowWorkItem;
}

function harness(
  items: WorkflowWorkItem[] = [item()],
  taskOverrides: Partial<Task> = {},
  settings: Partial<Settings> = {},
) {
  const task = {
    id: "FN-8932", title: "Memory layer 4a", description: "", column: "todo",
    dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: stale(GRACE_EXCEEDED), updatedAt: stale(GRACE_EXCEEDED),
    ...taskOverrides,
  } as unknown as Task;
  const transitions: Array<{ id: string; state: string; patch: Record<string, unknown> }> = [];
  const logged: string[] = [];
  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, ...settings } as Settings)),
    listDueWorkflowWorkItems: vi.fn(async () => items),
    getTask: vi.fn(async (id: string) => (id === task.id ? task : undefined)),
    transitionWorkflowWorkItem: vi.fn(async (id: string, state: string, patch: Record<string, unknown>) => {
      transitions.push({ id, state, patch });
      return { ...items.find((entry) => entry.id === id)!, state };
    }),
    logEntry: vi.fn(async (_id: string, message: string) => { logged.push(message); }),
    getRootDir: vi.fn(() => "/repo"),
    getTasksDir: vi.fn(() => ""),
  } as unknown as TaskStore;
  resolveTaskLifecycleColumnsMock.mockResolvedValue({ complete: "done", archived: "archived" });
  return { task, store, transitions, logged, manager: new SelfHealingManager(store, { rootDir: "/repo" }) };
}

describe("reconcileStrandedWorkflowContinuations", () => {
  it("re-queues a running continuation whose lease has no owner left", async () => {
    recordRunAuditEventMock.mockClear();
    const { manager, transitions, logged } = harness();

    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(1);

    expect(transitions).toEqual([{
      id: "wi-1",
      state: "runnable",
      // Clearing BOTH is what makes the row claimable: a stale leaseOwner reads as owned, and a
      // surviving blockedReason keeps the claim predicate out.
      patch: expect.objectContaining({ leaseOwner: null, leaseExpiresAt: null, blockedReason: null, expectedState: "running" }),
    }]);
    expect(logged.join(" ")).toContain("re-queued");
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "workflowWorkItem:reconcile-stranded-requeued",
      metadata: expect.objectContaining({ taskId: "FN-8932", priorState: "running", reason: "dead-lease" }),
    }));
  });

  /* Every stranded shape observed in the incident, plus the expired-lease variant. */
  it("re-queues each stranded shape a dispatcher would never re-poll", async () => {
    for (const [label, overrides] of [
      ["running, null lease expiry", { state: "running", leaseExpiresAt: null }],
      ["running, expired lease", { state: "running", leaseExpiresAt: stale(GRACE_EXCEEDED) }],
      ["held, null blocked reason", { state: "held", leaseOwner: null, blockedReason: null }],
      ["held, principal routing reason", { state: "held", leaseOwner: null, blockedReason: "workflow-principal-role-pool-exhausted:executor" }],
    ] as Array<[string, Partial<WorkflowWorkItem>]>) {
      const { manager, transitions } = harness([item(overrides)]);
      await expect(manager.reconcileStrandedWorkflowContinuations(), label).resolves.toBe(1);
      expect(transitions[0]?.state, label).toBe("runnable");
    }
  });

  it("retires rows whose task can never run them again", async () => {
    for (const taskOverrides of [
      { column: "archived", deletedAt: stale(1) },
      { column: "archived" },
      { column: "done" },
    ] as Array<Partial<Task>>) {
      for (const state of ["running", "held", "runnable", "retrying"] as const) {
        const { manager, transitions } = harness([item({ state })], taskOverrides);
        await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(1);
        expect(transitions[0]?.state).toBe("cancelled");
      }
    }
  });

  it("does not treat default column ids as terminal for a custom workflow", async () => {
    const { manager, transitions } = harness([item()], { column: "done" });
    resolveTaskLifecycleColumnsMock.mockResolvedValue({ complete: "shipped", archived: "retired" });

    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(1);
    expect(transitions[0]?.state).toBe("runnable");
  });

  it("retires a row whose task no longer resolves at all", async () => {
    const { manager, transitions } = harness([item({ taskId: "FN-DELETED" })]);
    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(1);
    expect(transitions[0]?.state).toBe("cancelled");
  });

  /*
  The false positive that would be worse than the bug: re-queueing a row a live session still owns
  double-dispatches the task. Each guard is asserted separately so none can be dropped silently.
  */
  it("never touches a row that is live, owned, paused, operator-held, or too fresh", async () => {
    const cases: Array<[string, Parameters<typeof harness>]> = [
      ["unexpired lease", [[item({ leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() })], {}, {}]],
      ["too fresh", [[item({ updatedAt: new Date().toISOString() })], {}, {}]],
      ["manual-hold kind", [[item({ state: "held", kind: "manual-hold" })], {}, {}]],
      ["operator paused", [[item()], { userPaused: true } as Partial<Task>, {}]],
      ["task paused", [[item()], { paused: true } as Partial<Task>, {}]],
      ["engine paused", [[item()], {}, { enginePaused: true }]],
      ["global pause", [[item()], {}, { globalPause: true }]],
      ["scheduler-owned runnable", [[item({ state: "runnable", leaseOwner: null })], {}, {}]],
    ];
    for (const [label, args] of cases) {
      const { manager, transitions } = harness(...args);
      await expect(manager.reconcileStrandedWorkflowContinuations(), label).resolves.toBe(0);
      expect(transitions, label).toEqual([]);
    }
  });

  /*
  The write is compare-and-set fenced on the state the scan observed. A dispatcher that legitimately
  claimed the row in between must win, and the sweep must not count or log a repair it did not make.
  */
  it("does not count a repair when the compare-and-set loses to a real claim", async () => {
    const { manager, store, logged } = harness();
    (store.transitionWorkflowWorkItem as ReturnType<typeof vi.fn>).mockResolvedValue({ ...item(), state: "running" });
    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);
    expect(logged).toEqual([]);
  });
});

describe("evaluateStrandedContinuationReclaim", () => {
  const base = {
    item: { state: "running", kind: "task", leaseExpiresAt: null, blockedReason: null },
    taskTerminal: false, taskMissing: false, taskPaused: false,
    live: false, enginePaused: false, stalenessMs: GRACE_EXCEEDED, graceMs: 600_000, now: Date.now(),
  } as Parameters<typeof evaluateStrandedContinuationReclaim>[0];

  it("orders engine pause above every other disposition", () => {
    // Even a retirable row waits: a paused engine must make no autonomous writes at all.
    expect(evaluateStrandedContinuationReclaim({ ...base, enginePaused: true, taskMissing: true }))
      .toEqual({ action: "none", reason: "engine-paused" });
  });

  it("retires a dead task's row regardless of pause or liveness flags", () => {
    // Retirement sits ABOVE the pause/liveness guards on purpose — a deleted task has no operator
    // decision left to respect, and that ordering is why the month-old residue accumulated.
    expect(evaluateStrandedContinuationReclaim({ ...base, taskTerminal: true, taskPaused: true, live: true }))
      .toEqual({ action: "retire", reason: "task-terminal" });
  });

  it("treats a future lease expiry as proof of a live claim even past the grace window", () => {
    expect(evaluateStrandedContinuationReclaim({
      ...base,
      item: { ...base.item, leaseExpiresAt: new Date(base.now + 60_000).toISOString() },
      stalenessMs: 24 * 3_600_000,
    })).toEqual({ action: "none", reason: "lease-active" });
  });
});
