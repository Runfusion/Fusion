import { describe, expect, it, vi } from "vitest";
import "@fusion/core"; // register built-in traits
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

/*
FNXC:WorkflowColumns 2026-07-29-09:30 (Phase B — self-healing intake/hold vocabulary):
Proves the converted sweeps resolve their PRE-WIP columns from the task's workflow
instead of the literals "triage"/"todo".

WHY THIS MATTERS MORE THAN A GREEN SUITE. U11 merges the two pre-implementation
columns into one that KEEPS the id "todo" and DELETES "triage". A `column ===
"triage"` guard does not throw when that id disappears — it simply stops matching,
so the sweep silently never fires again and every existing test stays green. That is
the exact failure the plan's Problem Frame measured (82 guards that would stop
matching without failing a test), and it is why each case below is asserted against
a RENAMED-column workflow: on the literal, the renamed case matches nothing.

Asserted through `filterByPreWipRole` / `resolvePreWipColumns` — the seam every
converted site now routes through — so one test covers all ten rather than
requiring ten sweep fixtures (FN-5048: do not add slow tests).
*/

/** A workflow whose intake/hold columns are NOT named triage/todo. */
const RENAMED_IR: WorkflowIr = {
  version: "v2",
  name: "renamed-lifecycle",
  columns: [
    { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
    { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
  nodes: [],
  edges: [],
} as unknown as WorkflowIr;

function storeFor(ir?: WorkflowIr): TaskStore {
  return {
    getTaskWorkflowSelection: vi.fn(() => (ir ? { workflowId: "custom:renamed", stepIds: [] } : undefined)),
    getTaskWorkflowSelectionAsync: vi.fn(async () => (ir ? { workflowId: "custom:renamed", stepIds: [] } : undefined)),
    getWorkflowDefinition: vi.fn(async () => (ir ? { ir } : undefined)),
  } as unknown as TaskStore;
}

function managerFor(store: TaskStore): SelfHealingManager {
  const manager = Object.create(SelfHealingManager.prototype) as SelfHealingManager;
  (manager as unknown as Record<string, unknown>).store = store;
  (manager as unknown as Record<string, unknown>).options = {};
  return manager;
}

const task = (id: string, column: string): Task => ({ id, column } as unknown as Task);

type Internals = {
  resolvePreWipColumns(taskId: string, cache: Map<string, unknown>): Promise<{ intake: string; hold: string }>;
  filterByPreWipRole(tasks: Task[], roles: Array<"intake" | "hold">, cache: Map<string, unknown>): Promise<Task[]>;
};

describe("self-healing pre-WIP column vocabulary", () => {
  /*
  FNXC:WorkflowColumns 2026-07-29-12:15 (post-#2515 audit):
  THE CASE THIS CONVERSION EXISTS FOR. #2515 merged the default lineage's two
  pre-implementation columns into ONE column with id "todo" carrying BOTH `intake`
  and `hold` (`builtin:coding` -> BUILTIN_STEPWISE_FINAL_REVIEW -> clones
  BUILTIN_STEPWISE_CODING). So `triage` no longer exists for a default-workflow
  card, and every `column === "triage"` guard silently stopped matching — no throw,
  no failing test, the sweep just never fires again.

  Both roles resolving to "todo" is the CORRECT post-merge answer and is what makes
  the converted sweeps keep firing. Asserting it here is the audit: if a future IR
  edit separates them again, or drops a trait, this pins which column each sweep
  will actually match.
  */
  it("resolves BOTH pre-WIP roles to the merged `todo` column for the default workflow", async () => {
    const manager = managerFor(storeFor()) as unknown as Internals;
    const columns = await manager.resolvePreWipColumns("FN-1", new Map());
    expect(columns).toEqual({ intake: "todo", hold: "todo" });
  });

  it("matches a default-workflow card sitting in the merged column (the sweeps still fire)", async () => {
    const manager = managerFor(storeFor()) as unknown as Internals;
    const kept = await manager.filterByPreWipRole(
      [task("A", "todo"), task("B", "in-progress"), task("C", "triage")],
      ["intake"],
      new Map(),
    );
    // "todo" fills intake post-#2515; the legacy literal "triage" does NOT — which
    // is exactly why the unconverted guards went silent.
    expect(kept.map((t) => t.id)).toEqual(["A"]);
  });

  /*
  THE POINT OF THE CONVERSION. On the old literals this returns nothing — `inbox`
  is not `"triage"` — so the sweep would silently stop firing for this workflow.
  */
  it("resolves a RENAMED workflow's intake and hold columns", async () => {
    const manager = managerFor(storeFor(RENAMED_IR)) as unknown as Internals;
    const columns = await manager.resolvePreWipColumns("FN-1", new Map());
    expect(columns).toEqual({ intake: "inbox", hold: "backlog" });
  });

  it("filters by intake role across a renamed workflow", async () => {
    const manager = managerFor(storeFor(RENAMED_IR)) as unknown as Internals;
    const kept = await manager.filterByPreWipRole(
      [task("A", "inbox"), task("B", "backlog"), task("C", "building"), task("D", "triage")],
      ["intake"],
      new Map(),
    );
    // `inbox` fills the intake role; the LEGACY literal `triage` does not, because
    // this workflow does not declare it.
    expect(kept.map((t) => t.id)).toEqual(["A"]);
  });

  it("filters by intake OR hold role across a renamed workflow", async () => {
    const manager = managerFor(storeFor(RENAMED_IR)) as unknown as Internals;
    const kept = await manager.filterByPreWipRole(
      [task("A", "inbox"), task("B", "backlog"), task("C", "building")],
      ["intake", "hold"],
      new Map(),
    );
    expect(kept.map((t) => t.id)).toEqual(["A", "B"]);
  });

  /*
  Recovery sweeps must keep working when a workflow cannot be read: returning
  nothing would drop the card out of EVERY converted sweep, a silent loss of
  recovery worse than resolving imperfectly.

  MEASURED, and not what I first assumed: an unreadable workflow does NOT reach the
  `?? "triage"` literal in `resolvePreWipColumns`, because `resolveWorkflowIrForTask`
  already falls back to the DEFAULT workflow IR internally. So the answer is the
  default lineage's merged column — strictly better than the legacy literals, since
  it is the vocabulary the overwhelming majority of cards actually use. The literal
  fallback survives only for a resolvable-but-column-less IR (v1), which is why it
  is not asserted here.
  */
  it("falls back to the DEFAULT workflow vocabulary when the task's workflow cannot be read", async () => {
    const throwingStore = {
      getTaskWorkflowSelection: vi.fn(() => { throw new Error("unreadable"); }),
      getTaskWorkflowSelectionAsync: vi.fn(async () => { throw new Error("unreadable"); }),
      getWorkflowDefinition: vi.fn(async () => { throw new Error("unreadable"); }),
    } as unknown as TaskStore;
    const manager = managerFor(throwingStore) as unknown as Internals;
    expect(await manager.resolvePreWipColumns("FN-1", new Map())).toEqual({ intake: "todo", hold: "todo" });
  });

  /*
  The cache is caller-owned per sweep so a board of N cards on one workflow costs
  ONE IR read, not N. Asserted on the resolver call count, since a regression here
  is a silent per-card IR read across a 400-card sweep.
  */
  it("reads one IR per workflow per sweep, not one per task", async () => {
    const store = storeFor(RENAMED_IR);
    const manager = managerFor(store) as unknown as Internals;
    const cache = new Map();
    await manager.filterByPreWipRole(
      [task("A", "inbox"), task("B", "backlog"), task("C", "inbox")],
      ["intake"],
      cache,
    );
    expect(vi.mocked(store.getWorkflowDefinition)).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-14:20 (fleet — pause-abort router vocabulary):
The pause-abort recovery router routed on three literals: `in-review` twice (review progress, manual
merge hold) and `todo || in-progress` (active work). On a renamed board all three stopped matching, so
a parked card in a renamed lane fell through to `no-action` and was never recovered — silently, and with
every existing test still green, because they all use the legacy ids.

Each case below asserts the RENAMED lane routes correctly. Reverting any of the three conversions turns
its case into `no-action`, so these fail if the guards go back to literals.

Note the ACTIVE-WORK set is hold + countsTowardWip, NOT the intake + hold that `resolvePreWipColumns`
above returns: a card in intake is not mid-flight and must not be requeued as active work. The two sets
overlap on `hold`, which is exactly why using the wrong one would look right in a legacy-id test.
*/
const RENAMED_WITH_REVIEW: WorkflowIr = {
  version: "v2",
  name: "renamed-lifecycle-review",
  columns: [
    { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
    { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    /* Trait names are kebab (`merge`); `mergeOrchestration` is the FLAG that trait sets. */
    { id: "signoff", name: "Signoff", traits: [{ trait: "merge" }, { trait: "human-review" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
  nodes: [],
  edges: [],
} as unknown as WorkflowIr;

const PARK_ERROR =
  "Workflow graph failure surfaced after paused engine abort during pause/resume in 'todo' at node 'execute' — operator action required; retry or explicitly unpause/resume after inspecting the task";

type PauseAbortInternals = {
  resolveActiveWorkColumnsFor(taskId: string, cache: Map<string, unknown>): Promise<ReadonlySet<string>>;
  resolvePauseAbortColumnsFor(taskId: string, cache: Map<string, unknown>): Promise<{ review: ReadonlySet<string>; activeWork: ReadonlySet<string> }>;
  classifyPausedAbortWorkflowRecovery(
    task: Task,
    settings: unknown,
    isExecuting: boolean,
    columns: { review: ReadonlySet<string>; activeWork: ReadonlySet<string> },
  ): { kind: string; reason: string };
};

const parked = (column: string, steps: Array<{ status: string }> = []): Task => ({
  id: "FN-9100",
  column,
  status: "failed",
  error: PARK_ERROR,
  steps,
} as unknown as Task);

describe("self-healing pause-abort router column vocabulary", () => {
  const settings = { autoMerge: true } as unknown as Settings;

  it("resolves ACTIVE WORK as hold + wip on a renamed board, excluding intake", async () => {
    const manager = managerFor(storeFor(RENAMED_WITH_REVIEW)) as unknown as PauseAbortInternals;
    const active = await manager.resolveActiveWorkColumnsFor("FN-9100", new Map());
    expect(active.has("backlog")).toBe(true);
    expect(active.has("building")).toBe(true);
    // Intake is NOT active work — this is the distinction from resolvePreWipColumns.
    expect(active.has("inbox")).toBe(false);
  });

  it("requeues a park sitting in a RENAMED wip lane", async () => {
    const manager = managerFor(storeFor(RENAMED_WITH_REVIEW)) as unknown as PauseAbortInternals;
    const columns = await manager.resolvePauseAbortColumnsFor("FN-9100", new Map());
    const route = manager.classifyPausedAbortWorkflowRecovery(parked("building"), settings, false, columns);
    expect(route).toEqual({ kind: "node-requeue", reason: "pause-abort-active-work" });
  });

  it("resumes a completed park sitting in a RENAMED review lane", async () => {
    const manager = managerFor(storeFor(RENAMED_WITH_REVIEW)) as unknown as PauseAbortInternals;
    const columns = await manager.resolvePauseAbortColumnsFor("FN-9100", new Map());
    const task = parked("signoff", [{ status: "done" }, { status: "done" }]);
    const route = manager.classifyPausedAbortWorkflowRecovery(task, settings, false, columns);
    expect(route).toEqual({ kind: "work-item-resume", reason: "pause-abort-review-progress" });
  });

  /*
  The degraded path is the reason both resolvers union the legacy ids: an unreadable workflow must keep
  its former recovery behaviour rather than resolve an empty set and go inert.
  */
  it("keeps recovering legacy-id boards when the workflow is unresolvable", async () => {
    const manager = managerFor(storeFor(undefined)) as unknown as PauseAbortInternals;
    const columns = await manager.resolvePauseAbortColumnsFor("FN-9100", new Map());
    expect(manager.classifyPausedAbortWorkflowRecovery(parked("in-progress"), settings, false, columns).kind)
      .toBe("node-requeue");
    expect(manager.classifyPausedAbortWorkflowRecovery(parked("todo"), settings, false, columns).kind)
      .toBe("node-requeue");
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-15:20 (fleet — task:moved fan-out vocabulary):
The fan-out routed on five literals. On a renamed board all of it went inert at once — the board-stall
counter stopped counting, in-review rebind stopped firing, completed-task reconciliation stopped running
— and none of that fails a test, because the move itself still happens.

The sync/async split below is asserted deliberately. The counter MUST increment synchronously:
`runBoardStallAutoRecoverySweep` makes its own recovery moves and then reads the counter in the same
pass, so an increment deferred behind an await is read as a stale zero and a real recovery is reported
as unrecovered. That is not hypothetical — it is what board-stall-auto-recovery.test.ts caught when this
conversion first put the whole listener behind one await.
*/
describe("self-healing task:moved fan-out column vocabulary", () => {
  type FanoutInternals = {
    resolveMoveFanoutColumnsSync(taskId: string): { wip: ReadonlySet<string>; review: ReadonlySet<string>; complete: ReadonlySet<string>; archived: ReadonlySet<string>; hold: ReadonlySet<string> };
    handleTaskMovedFanout(task: Task, from: string, to: string): Promise<void>;
    reconcileInReviewBranchRebind: unknown;
    reconcileCompletedTask: unknown;
  };

  function syncStoreFor(ir?: WorkflowIr): TaskStore {
    return {
      ...storeFor(ir),
      resolveTaskWorkflowIrSync: vi.fn(() => ir),
    } as unknown as TaskStore;
  }

  it("resolves every fan-out lane from a renamed board", () => {
    const manager = managerFor(syncStoreFor(RENAMED_WITH_REVIEW)) as unknown as FanoutInternals;
    const c = manager.resolveMoveFanoutColumnsSync("FN-9200");
    expect(c.wip.has("building")).toBe(true);
    expect(c.review.has("signoff")).toBe(true);
    expect(c.complete.has("shipped")).toBe(true);
    expect(c.hold.has("backlog")).toBe(true);
  });

  it("keeps legacy ids when the store cannot resolve synchronously", () => {
    const manager = managerFor(storeFor(undefined)) as unknown as FanoutInternals;
    const c = manager.resolveMoveFanoutColumnsSync("FN-9200");
    expect(c.wip.has("in-progress")).toBe(true);
    expect(c.review.has("in-review")).toBe(true);
    expect(c.complete.has("done")).toBe(true);
  });

  it("fires the in-review rebind for a move into a RENAMED review lane", async () => {
    const manager = managerFor(syncStoreFor(RENAMED_WITH_REVIEW)) as unknown as FanoutInternals;
    const rebind = vi.fn(async () => undefined);
    manager.reconcileInReviewBranchRebind = rebind;
    manager.reconcileCompletedTask = vi.fn(async () => undefined);
    await manager.handleTaskMovedFanout(task("FN-9200", "signoff"), "building", "signoff");
    expect(rebind).toHaveBeenCalledTimes(1);
  });

  it("reconciles completion across RENAMED review -> complete and complete -> archived", async () => {
    const manager = managerFor(syncStoreFor(RENAMED_WITH_REVIEW)) as unknown as FanoutInternals;
    const reconcile = vi.fn(async () => undefined);
    manager.reconcileInReviewBranchRebind = vi.fn(async () => undefined);
    manager.reconcileCompletedTask = reconcile;
    await manager.handleTaskMovedFanout(task("FN-9200", "shipped"), "signoff", "shipped");
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("does not reconcile completion on an unrelated renamed move", async () => {
    const manager = managerFor(syncStoreFor(RENAMED_WITH_REVIEW)) as unknown as FanoutInternals;
    const reconcile = vi.fn(async () => undefined);
    manager.reconcileInReviewBranchRebind = vi.fn(async () => undefined);
    manager.reconcileCompletedTask = reconcile;
    await manager.handleTaskMovedFanout(task("FN-9200", "building"), "backlog", "building");
    expect(reconcile).not.toHaveBeenCalled();
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-16:05 (fleet — pause-abort requeue TARGET):
The recovery requeued to a hardcoded "todo". A hardcoded target is a worse failure than a stale guard:
a stale guard stops matching, but a move to a column the board does not declare is a write into nowhere.
Asserted on `moveTask`, because the target is the whole point of this conversion — a test that only
checked the guards would pass with the write still hardcoded.
*/
describe("self-healing pause-abort requeue target vocabulary", () => {
  function recoveryStoreFor(ir: WorkflowIr | undefined, parkedTask: Task) {
    const moveTask = vi.fn(async () => undefined);
    const store = {
      ...storeFor(ir),
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, autoMerge: true })),
      listTasks: vi.fn(async () => [parkedTask]),
      getTask: vi.fn(async () => parkedTask),
      updateTask: vi.fn(async () => ({})),
      moveTask,
      logEntry: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
      getRootDir: vi.fn(() => "/tmp/test-project"),
    } as unknown as TaskStore;
    return { store, moveTask };
  }

  it("requeues to the board's own HOLD lane, not a hardcoded todo", async () => {
    const parkedInWip = parked("building");
    const { store, moveTask } = recoveryStoreFor(RENAMED_WITH_REVIEW, parkedInWip);
    const manager = managerFor(store) as unknown as { recoverPausedAbortFailures(): Promise<number> };
    await manager.recoverPausedAbortFailures();
    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(moveTask).mock.calls[0]?.[1]).toBe("backlog");
  });

  it("still requeues to todo when the workflow will not resolve", async () => {
    const parkedInWip = parked("in-progress");
    const { store, moveTask } = recoveryStoreFor(undefined, parkedInWip);
    const manager = managerFor(store) as unknown as { recoverPausedAbortFailures(): Promise<number> };
    await manager.recoverPausedAbortFailures();
    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(moveTask).mock.calls[0]?.[1]).toBe("todo");
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-17:10 (fleet — active/terminal membership):
Two multi-id membership guards, both asking "is this card live or finished?" and both matching NOTHING
on a renamed board.

`reconcilePreExecutionWorktrees` is the destructive one: a renamed board made every working card look
parked, so the sweep would have SEIZED a worktree from live work. That is why over-inclusion is the
acceptable failure direction for it and the project union is the right scope — a column wrongly counted
as active only leaves a worktree alone.
*/
describe("self-healing active/terminal membership vocabulary", () => {
  function releaseStoreFor(ir: WorkflowIr | undefined, tasks: Task[]) {
    return {
      ...storeFor(ir),
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
      listTasks: vi.fn(async () => tasks),
      getProjectWorkflowIds: vi.fn(async () => (ir ? ["custom:renamed"] : [])),
      listWorkflowDefinitions: vi.fn(async () => (ir ? [{ id: "custom:renamed", ir }] : [])),
      logEntry: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
    } as unknown as TaskStore;
  }

  const withWorktree = (id: string, column: string): Task => ({
    id,
    column,
    worktree: `/tmp/wt/${id}`,
    updatedAt: "2020-01-01T00:00:00.000Z",
    columnMovedAt: "2020-01-01T00:00:00.000Z",
  } as unknown as Task);

  it("does not seize the worktree of a card in a RENAMED working lane", async () => {
    const store = releaseStoreFor(RENAMED_WITH_REVIEW, [withWorktree("FN-9300", "building")]);
    const release = vi.fn(async () => true);
    const manager = Object.create(SelfHealingManager.prototype) as SelfHealingManager;
    (manager as unknown as Record<string, unknown>).store = store;
    (manager as unknown as Record<string, unknown>).options = { releasePreExecutionWorktree: release };
    await (manager as unknown as { reconcilePreExecutionWorktrees(): Promise<number> }).reconcilePreExecutionWorktrees();
    expect(release).not.toHaveBeenCalled();
  });

  it("does not seize the worktree of a card in a RENAMED review lane", async () => {
    const store = releaseStoreFor(RENAMED_WITH_REVIEW, [withWorktree("FN-9301", "signoff")]);
    const release = vi.fn(async () => true);
    const manager = Object.create(SelfHealingManager.prototype) as SelfHealingManager;
    (manager as unknown as Record<string, unknown>).store = store;
    (manager as unknown as Record<string, unknown>).options = { releasePreExecutionWorktree: release };
    await (manager as unknown as { reconcilePreExecutionWorktrees(): Promise<number> }).reconcilePreExecutionWorktrees();
    expect(release).not.toHaveBeenCalled();
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-17:45 (fleet — FN-5256 liveness protection):
FN-5256 exists because nulling a live task's worktree metadata yanks the worktree from a still-running
shell. The guard that enforces it compared `task.column` against "in-progress"/"in-review", so on a
renamed board it protected NOTHING and the very incident it was written to prevent came back.

Asserted on `updateTask` NOT being called: the protection is the absence of a write, so a test that only
counted the return value would pass while the metadata was being cleared.
*/
describe("self-healing FN-5256 liveness protection vocabulary", () => {
  it("does not clear worktree metadata for a card in a RENAMED working lane", async () => {
    const live = {
      id: "FN-9400",
      column: "building",
      worktree: "/tmp/wt/FN-9400-missing",
      branch: "fusion/FN-9400",
    } as unknown as Task;
    const updateTask = vi.fn(async () => undefined);
    const store = {
      ...storeFor(RENAMED_WITH_REVIEW),
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
      listTasks: vi.fn(async () => [live]),
      getTask: vi.fn(async () => live),
      updateTask,
      logEntry: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
      getRootDir: vi.fn(() => "/tmp/test-project"),
      getProjectWorkflowIds: vi.fn(async () => ["custom:renamed"]),
      listWorkflowDefinitions: vi.fn(async () => [{ id: "custom:renamed", ir: RENAMED_WITH_REVIEW }]),
    } as unknown as TaskStore;

    const manager = Object.create(SelfHealingManager.prototype) as SelfHealingManager;
    (manager as unknown as Record<string, unknown>).store = store;
    (manager as unknown as Record<string, unknown>).options = { rootDir: "/tmp/test-project", getExecutingTaskIds: () => new Set() };

    await (manager as unknown as { reconcileTaskWorktreeMetadata(o?: unknown): Promise<number> }).reconcileTaskWorktreeMetadata();
    expect(updateTask).not.toHaveBeenCalled();
  });
});
