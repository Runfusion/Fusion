import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor.js";
import { activeSessionRegistry } from "../active-session-registry.js";
import { SelfHealingManager } from "../self-healing.js";
import { PAUSE_ABORT_PARK_ERROR_MARKER, PAUSE_ABORT_PARK_OPERATOR_MARKER } from "../self-healing-constants.js";

/*
FNXC:NodeWorktreeIsolation 2026-07-29-02:10 (FN-6756 — planner worktrees reaped from under live planners):
REGRESSION SUITE for a bug users hit: worktrees reaped while a planner was still
working in them.

MECHANISM. Under plan-in-place, specification runs while the card sits in
`todo`/`triage`. `reapLeakedConcurrencySlots` treats both columns as reapable
("a task waiting to run must not pin a worktree" — written before planning moved
there), and every gate ahead of the last one passes for a planner:

  - it IS a `listWorktreeHolders()` row: ensureTaskWorktreeForPlanning ->
    ensureGraphCustomNodeWorktree -> addActiveWorktree
  - `todo`/`triage` is a reapable column
  - it is NOT in the executor's `executing` set — a planner is triage-owned
  - planning routinely outlives the 60s LEAKED_WORKTREE_SLOT_GRACE_MS

...leaving `clearPhantomExecutorBinding` deciding alone. It computed liveness from
four TaskExecutor-owned sets only, so a triage planning session — which lives in
TriageProcessor's OWN activeSessions map and registers in the module-level
activeSessionRegistry — matched none of them. It returned true, released the slot,
and then unregistered the planner's registry paths: destroying the evidence that
proved the planner alive.

This is FN-8600 recurring through a second sweep. That fix registered planning
paths in the registry and taught the self-owned-branch reclaim sweep to consult
`isPathActive`. The leaked-slot reaper never got the same signal — fixed at one
surface, not enumerated across all.

The tests below assert the invariant at BOTH levels, because either alone is
insufficient: the unit case pins the guard, and the sweep case pins that the guard
is actually reached and honored by the reaper.
*/

function makeExecutorWithHeldWorktree(taskId: string, worktreePath: string): TaskExecutor {
  const executor = Object.create(TaskExecutor.prototype) as TaskExecutor;
  const priv = executor as unknown as Record<string, unknown>;
  // Exactly the surfaces the guard consults, all EMPTY — the true state during
  // planning, since the planner's session is held by TriageProcessor.
  priv.activeSessions = new Map();
  priv.activeStepExecutors = new Map();
  priv.activeWorkflowStepSessions = new Map();
  priv.activeCliTaskSessions = new Map();
  priv.activeWorktrees = new Map([[taskId, new Set([worktreePath])]]);
  priv.executing = new Set();
  priv.recoveringCompleted = new Set();
  priv.resumingUnpaused = new Set();
  priv.approvalSuspended = new Set();
  priv.approvalResumeAfterUnwind = new Set();
  priv.effectiveColumnAgentByTask = new Map();
  return executor;
}

const PLANNER_TASK = "FN-6756-PLANNER";
const PLANNER_WORKTREE = "/tmp/fn-6756-planner-worktree";

afterEach(() => {
  activeSessionRegistry.clear();
  vi.restoreAllMocks();
});

describe("FN-6756: a live planner's worktree survives the leaked-slot reaper", () => {
  /*
  Reverting the `registeredSessionPaths.length > 0` term in
  clearPhantomExecutorBinding turns this red: the method returns true and, worse,
  unregisters the planner's path on its way out.
  */
  it("clearPhantomExecutorBinding refuses when the task holds a registered session path", () => {
    const executor = makeExecutorWithHeldWorktree(PLANNER_TASK, PLANNER_WORKTREE);
    activeSessionRegistry.registerPath(PLANNER_WORKTREE, {
      taskId: PLANNER_TASK,
      kind: "planning",
      ownerKey: "triage:plan",
    });

    expect(executor.clearPhantomExecutorBinding(PLANNER_TASK)).toBe(false);

    // The binding and the registration must both survive the refusal — a refusal
    // that still tore down state would be worse than none.
    expect(activeSessionRegistry.isPathActive(PLANNER_WORKTREE)).toBe(true);
    expect(
      (executor as unknown as { activeWorktrees: Map<string, Set<string>> }).activeWorktrees.get(PLANNER_TASK),
    ).toEqual(new Set([PLANNER_WORKTREE]));
  });

  /*
  The kind is deliberately not part of the guard: any registered surface means
  someone is working in that worktree. Pinning one representative non-executor kind
  keeps a future "only refuse for kind === planning" narrowing honest.
  */
  it("refuses for any registered session kind, not just planning", () => {
    for (const kind of ["planning", "ai-merge", "step-session"] as const) {
      activeSessionRegistry.clear();
      const executor = makeExecutorWithHeldWorktree(PLANNER_TASK, PLANNER_WORKTREE);
      activeSessionRegistry.registerPath(PLANNER_WORKTREE, {
        taskId: PLANNER_TASK,
        kind,
        ownerKey: `owner:${kind}`,
      });
      expect(executor.clearPhantomExecutorBinding(PLANNER_TASK), `kind=${kind}`).toBe(false);
    }
  });

  /*
  The guard must NOT become a blanket refusal: a genuinely phantom binding — no
  executor surface AND no registration — is exactly what FN-6736's reaper exists to
  clear, and blocking it would trade this bug for a wedged queue.
  */
  it("still clears a genuine phantom binding, and actually removes the binding", () => {
    const phantomTask = "FN-6756-PHANTOM";
    const phantomWorktree = "/tmp/fn-6756-phantom-worktree";
    const executor = makeExecutorWithHeldWorktree(phantomTask, phantomWorktree);
    const priv = executor as unknown as { activeWorktrees: Map<string, Set<string>>; executing: Set<string> };
    priv.executing.add(phantomTask);
    expect(activeSessionRegistry.pathsForTask(phantomTask)).toEqual([]);

    expect(executor.clearPhantomExecutorBinding(phantomTask)).toBe(true);

    /*
    Asserting the RETURN VALUE alone would pass a cleanup that reports success
    without doing anything — the exact shape of defect this suite exists to catch
    on the other side. Pin the observable effect too.
    */
    expect(priv.activeWorktrees.has(phantomTask)).toBe(false);
    expect(priv.executing.has(phantomTask)).toBe(false);
  });

  /*
  END TO END through the sweep itself. The unit case above proves the guard; this
  proves the reaper reaches and honors it for a card in a reapable column, past the
  grace, with the executor's sets empty — i.e. the exact reported shape.
  */
  /*
  BOTH reaper surfaces, not just the reported one. `reapLeakedConcurrencySlots`
  treats `todo` AND `triage` as reapable, and plan-in-place puts specification in
  `todo` while Coding (Ideas) intake sits in `triage` — so a repro-only test would
  leave half the exposed surface unguarded. AGENTS.md Surface Enumeration: the
  regression test asserts the invariant across ALL known surfaces, not the single
  reported reproduction.
  */
  it.each(["todo", "triage"] as const)(
    "reapLeakedConcurrencySlots does not reap a planning card in %s past the grace",
    async (column) => {
    const executor = makeExecutorWithHeldWorktree(PLANNER_TASK, PLANNER_WORKTREE);
    activeSessionRegistry.registerPath(PLANNER_WORKTREE, {
      taskId: PLANNER_TASK,
      kind: "planning",
      ownerKey: "triage:plan",
    });

    // Entered the column well past LEAKED_WORKTREE_SLOT_GRACE_MS (60s).
    const staleEntry = new Date(Date.now() - 10 * 60_000).toISOString();
    const store = {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
      getTask: vi.fn(async () => ({
        id: PLANNER_TASK,
        column,
        status: "planning",
        columnMovedAt: staleEntry,
        updatedAt: staleEntry,
      })),
      logEntry: vi.fn(async () => undefined),
    };

    const manager = Object.create(SelfHealingManager.prototype) as SelfHealingManager;
    (manager as unknown as Record<string, unknown>).store = store;
    (manager as unknown as Record<string, unknown>).options = {
      listWorktreeHolders: () => [{ taskId: PLANNER_TASK, worktreePath: PLANNER_WORKTREE }],
      getExecutingTaskIds: () => new Set<string>(),
      clearPhantomExecutorBinding: (taskId: string) => executor.clearPhantomExecutorBinding(taskId),
    };

    const reaped = await manager.reapLeakedConcurrencySlots();

    expect(reaped, `a live planner's slot must not be reaped from ${column}`).toBe(0);
    expect(activeSessionRegistry.isPathActive(PLANNER_WORKTREE)).toBe(true);
    // The binding must SURVIVE, not merely go unreported.
    expect(
      (executor as unknown as { activeWorktrees: Map<string, Set<string>> }).activeWorktrees.get(PLANNER_TASK),
    ).toEqual(new Set([PLANNER_WORKTREE]));
    expect(store.logEntry).not.toHaveBeenCalled();
  },
  );
  /*
  FNXC:NodeWorktreeIsolation 2026-07-29-04:20 (FN-6756 — the SECOND door, PR #2531 review):
  greptile caught that the chokepoint fix was INCOMPLETE. Adding a refusal to
  `clearPhantomExecutorBinding` only protects callers that HONOR the return value.
  `recoverPausedAbortFailures` discarded it, so a live planner was still losing its
  worktree through pause-abort recovery — and that path moves the card to `todo`
  BEFORE releasing ownership, so the executor-only gate let it be requeued too.

  This is the same failure that produced the original bug: FN-8600 was fixed at the
  reclaim sweep and never enumerated to the leaked-slot reaper; the leaked-slot
  reaper was then fixed and not enumerated to pause-abort. Hence a test per caller,
  not per report.
  */
  it("recoverPausedAbortFailures defers while a live session path is registered", async () => {
    activeSessionRegistry.registerPath(PLANNER_WORKTREE, {
      taskId: PLANNER_TASK,
      kind: "planning",
      ownerKey: "triage:plan",
    });

    const parkedTask = {
      id: PLANNER_TASK,
      column: "todo",
      status: "failed",
      error: `${PAUSE_ABORT_PARK_ERROR_MARKER} — ${PAUSE_ABORT_PARK_OPERATOR_MARKER}`,
      paused: false,
      userPaused: false,
      steps: [],
    };
    const store = {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
      listTasks: vi.fn(async () => [parkedTask]),
      getTask: vi.fn(async () => parkedTask),
      moveTask: vi.fn(async () => undefined),
      updateTask: vi.fn(async () => undefined),
      logEntry: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
    };

    const executorProbe = makeExecutorWithHeldWorktree(PLANNER_TASK, PLANNER_WORKTREE);
    const clearPhantomExecutorBinding = vi.fn(() => true);
    const manager = Object.create(SelfHealingManager.prototype) as SelfHealingManager;
    (manager as unknown as Record<string, unknown>).store = store;
    (manager as unknown as Record<string, unknown>).options = {
      getExecutingTaskIds: () => new Set<string>(),
      hasLiveSessionSurface: (id: string) => executorProbe.hasLiveSessionSurface(id),
      clearPhantomExecutorBinding,
    };

    const recovered = await manager.recoverPausedAbortFailures();

    expect(recovered, "a card with a live planner must not be recovered").toBe(0);
    // Neither the backward move nor the ownership release may happen.
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(clearPhantomExecutorBinding).not.toHaveBeenCalled();
    expect(activeSessionRegistry.isPathActive(PLANNER_WORKTREE)).toBe(true);
  });
  /*
  FNXC:NodeWorktreeIsolation 2026-07-29-05:10 (FN-6756 — the reporting half, PR #2531 review):
  A refused release must not merely fail to clear — it must not NARRATE success.

  The original defect had two halves and the second is why nobody caught it from
  logs: after ignoring the refusal, the path still wrote "Auto-recovered: pause-abort
  park cleared", emitted `task:auto-recover-paused-abort-park`, and incremented the
  recovered counter. An operator reading the task log saw a clean recovery at the
  exact moment their planner lost its worktree.

  This drives the refusal through the executor's REAL guard (not a stubbed boolean),
  with the registry pre-gate deliberately bypassed — the task has no registered path,
  but an executor session surface is live. That is the defense-in-depth branch, and
  it asserts the full no-op: no un-park, no move, no log, no audit, no count.
  */
  it("a live executor session defers pause-abort recovery without logging, auditing or counting it", async () => {
    const taskId = "FN-6756-REFUSED";
    const executor = makeExecutorWithHeldWorktree(taskId, "/tmp/fn-6756-refused-worktree");
    // Live EXECUTOR session surface, and NO registry entry — so the registry
    // pre-gate lets this through and clearPhantomExecutorBinding itself refuses.
    (executor as unknown as { activeSessions: Map<string, unknown> }).activeSessions.set(taskId, { dispose() {} });
    expect(activeSessionRegistry.pathsForTask(taskId)).toEqual([]);

    const parkedTask = {
      id: taskId,
      column: "in-progress",
      status: "failed",
      error: `${PAUSE_ABORT_PARK_ERROR_MARKER} — ${PAUSE_ABORT_PARK_OPERATOR_MARKER}`,
      paused: false,
      userPaused: false,
      steps: [],
    };
    const store = {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
      listTasks: vi.fn(async () => [parkedTask]),
      getTask: vi.fn(async () => parkedTask),
      moveTask: vi.fn(async () => undefined),
      updateTask: vi.fn(async () => undefined),
      logEntry: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
    };

    const manager = Object.create(SelfHealingManager.prototype) as SelfHealingManager;
    (manager as unknown as Record<string, unknown>).store = store;
    (manager as unknown as Record<string, unknown>).options = {
      getExecutingTaskIds: () => new Set<string>(),
      hasLiveSessionSurface: (id: string) => executor.hasLiveSessionSurface(id),
      clearPhantomExecutorBinding: (id: string) => executor.clearPhantomExecutorBinding(id),
    };

    const recovered = await manager.recoverPausedAbortFailures();

    expect(recovered, "a refused release must not be counted as a recovery").toBe(0);
    expect(store.updateTask, "the park must not be cleared").not.toHaveBeenCalled();
    expect(store.moveTask, "the card must not be requeued").not.toHaveBeenCalled();
    expect(store.logEntry, "no 'Auto-recovered' entry may be written").not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent, "no recovery audit may be emitted").not.toHaveBeenCalled();
    // ...and the worktree the live session is using survives.
    expect(
      (executor as unknown as { activeWorktrees: Map<string, Set<string>> }).activeWorktrees.has(taskId),
    ).toBe(true);
  });


  /*
  FNXC:NodeWorktreeIsolation 2026-07-29-06:05 (FN-6756 — the torn write, PR #2531 review):
  ORDERING. greptile caught that my first correction traded one fault for another:
  hoisting the release ABOVE the fallible writes meant an `updateTask`/`moveTask`
  rejection landed AFTER ownership had already been given up — the task un-repaired,
  the slot released, and nothing owning the repair. Same shape U12 hit on re-home:
  irreversible step committed before the fallible step.

  The release now runs LAST. This drives a write failure and asserts ownership is
  still held, so the next sweep can retry against intact state.
  */
  it("keeps worktree ownership when a recovery write fails", async () => {
    const taskId = "FN-6756-TORN";
    const worktree = "/tmp/fn-6756-torn-worktree";
    const executor = makeExecutorWithHeldWorktree(taskId, worktree);

    const parkedTask = {
      id: taskId,
      column: "in-progress",
      status: "failed",
      error: `${PAUSE_ABORT_PARK_ERROR_MARKER} — ${PAUSE_ABORT_PARK_OPERATOR_MARKER}`,
      paused: false,
      userPaused: false,
      steps: [],
    };
    const store = {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
      listTasks: vi.fn(async () => [parkedTask]),
      getTask: vi.fn(async () => parkedTask),
      // The fallible write rejects, exactly as a store conflict would.
      updateTask: vi.fn(async () => { throw new Error("store rejected the un-park"); }),
      moveTask: vi.fn(async () => undefined),
      logEntry: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
    };

    const clearPhantomExecutorBinding = vi.fn((id: string) => executor.clearPhantomExecutorBinding(id));
    const manager = Object.create(SelfHealingManager.prototype) as SelfHealingManager;
    (manager as unknown as Record<string, unknown>).store = store;
    (manager as unknown as Record<string, unknown>).options = {
      getExecutingTaskIds: () => new Set<string>(),
      hasLiveSessionSurface: (id: string) => executor.hasLiveSessionSurface(id),
      clearPhantomExecutorBinding,
    };

    const recovered = await manager.recoverPausedAbortFailures();

    expect(recovered, "a failed write must not count as a recovery").toBe(0);
    expect(clearPhantomExecutorBinding, "ownership must not be released before the writes commit").not.toHaveBeenCalled();
    expect(
      (executor as unknown as { activeWorktrees: Map<string, Set<string>> }).activeWorktrees.has(taskId),
      "ownership must survive so the next sweep retries against intact state",
    ).toBe(true);
  });
});