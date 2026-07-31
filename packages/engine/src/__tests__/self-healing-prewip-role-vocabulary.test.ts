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
