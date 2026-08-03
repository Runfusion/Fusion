/*
FNXC:WorkflowLifecycleColumns 2026-07-31-02:40 (batch-core feed: task-update.ts 3 → 0):

THE HEADLINE IS NOT A RENAMED BOARD — IT IS A COLUMN THAT NO LONGER EXISTS.

Adding a new dependency to a hold-lane card re-seeds it for re-specification, and the destination was
the literal `"triage"`. U11 (#2515) DELETED that column. The default lineage is now
`todo | in-progress | in-review | done | archived`, so on a STOCK board — no renaming involved —
this moved the card into a column nothing declares and nothing renders. The card leaves its lane and
appears in none, recoverable only by moving it back by hand.

The old behaviour therefore cannot be preserved: the column it targeted is gone. The card now stays
put when the intake lane is where it already is (the default board's case), while the status reset
and the log entry still record the re-specification.

WHEN THE WORKFLOW WILL NOT RESOLVE, THE COLUMN IS LEFT ALONE. There is deliberately no literal
fallback for the DESTINATION: refusing to move is recoverable; writing a column that may not exist is
what caused this. The source-lane check keeps its documented literal default, because failing to
recognise the hold lane only skips the re-seed.

SECOND SITE: clearing the `paused` STATUS on unassignment. Keyed on the wip/review literals, a
renamed board left `status: "paused"` behind after the pause itself was lifted — a card that is not
paused but says it is, in every status-driven surface, forever.

REVERT PROOF, measured: restore `task.column = "triage"` and the first case fails on the column
value; restore the wip/review literals and the renamed-unassign case fails. 3 of 5 fail overall.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../types.js";
import type { TaskStore } from "../store.js";
import { updateTaskUnlockedImpl } from "../task-store/task-update.js";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
    { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

/** The post-U11 default lineage: intake and hold are the SAME column, and `triage` is gone. */
const DEFAULT_IR = {
  version: "v2", id: "builtin:coding", name: "coding", nodes: [], edges: [],
  columns: [
    { id: "todo", name: "Todo", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "in-progress", name: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "in-review", name: "In Review", traits: [{ trait: "merge" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
};

function harness(task: Partial<Task>, ir: unknown) {
  const row = {
    id: "FN-1", column: "todo", dependencies: [], steps: [], log: [], status: null,
    title: "t", description: "d", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    ...task,
  } as unknown as Task;
  const selection = { workflowId: "wf", stepIds: [] as string[] };
  const store = {
    taskDir: () => "/tmp/does-not-matter",
    readTaskJson: async () => row,
    writeTaskJson: vi.fn(async () => undefined),
    atomicWriteTaskJson: vi.fn(async () => undefined),
    syncAgentTaskLinkOnReassignment: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    getSettings: vi.fn(async () => ({})),
    assertNoDependencyCycle: vi.fn(async () => undefined),
    getTaskWorkflowSelection: () => (ir ? selection : undefined),
    getTaskWorkflowSelectionAsync: async () => (ir ? selection : undefined),
    getWorkflowDefinition: async () => (ir ? { ir } : undefined),
    emit: vi.fn(),
    isWatching: false,
    taskCache: new Map(),
    /*
    FNXC:WorkflowEvents 2026-08-03-02:16:
    Real TaskStore always has laneCache; dependency re-spec emits only on a real column move and
    caches the same lanes payload listeners receive on task:moved.
    */
    laneCache: { set: vi.fn(), get: vi.fn(), invalidate: vi.fn() },
  } as Record<string, unknown>;
  /*
  The impl touches a long tail of TaskStore methods that have nothing to do with the column decision
  (atomic writes, agent-link sync, lifecycle event emission, …). A Proxy answering every unlisted
  method with an async no-op keeps this harness from becoming a maintenance burden that has to grow
  each time an unrelated call is added to the impl — the explicit entries above are exactly the ones
  whose RETURN VALUE the assertions depend on.
  */
  const proxied = new Proxy(store, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as unknown as TaskStore;
  return { store: proxied, row };
}

const run = (store: TaskStore, updates: Record<string, unknown>) =>
  updateTaskUnlockedImpl(store, "FN-1", updates as never).catch((err: unknown) => {
    // The impl writes PROMPT.md and other side files; a filesystem failure after the column decision
    // is irrelevant to what this file asserts, so surface the mutated row instead of the error.
    if (err instanceof Error && /ENOENT|EACCES|no such file/i.test(err.message)) return null;
    throw err;
  });

describe("adding a dependency never parks a card in a deleted column", () => {
  it("leaves a DEFAULT-board card in todo instead of moving it to the deleted 'triage'", async () => {
    // Pre-fix this wrote column = "triage", which the post-U11 default lineage does not declare, so
    // the card rendered in no column at all.
    const { store, row } = harness({ column: "todo", dependencies: [] }, DEFAULT_IR);

    await run(store, { dependencies: ["FN-2"] });

    expect(row.column).toBe("todo");
    expect(row.column).not.toBe("triage");
  });

  it("still records the re-specification when the card does not move", async () => {
    // The status reset and log entry are the operator-visible signal; only the teleport is dropped.
    const { store, row } = harness({ column: "todo", dependencies: [], status: "queued" }, DEFAULT_IR);

    await run(store, { dependencies: ["FN-2"] });

    expect(row.status).toBeUndefined();
    expect(row.log.some((e) => e.action.includes("re-specification"))).toBe(true);
  });

  it("moves a RENAMED board's hold card to its own intake lane", async () => {
    // Here intake and hold ARE different columns, so the move is real — and it goes to `inbox`,
    // a column this board actually declares.
    const { store, row } = harness({ column: "backlog", dependencies: [] }, RENAMED_IR);

    await run(store, { dependencies: ["FN-2"] });

    expect(row.column).toBe("inbox");
  });

  it("emits task:moved with the same resolved lanes used for the relocation", async () => {
    /*
    FNXC:WorkflowEvents 2026-08-03-02:16:
    Regression for the double-IR-resolve hazard: from/to must not ship without lanes, or self-healing
    falls back to builtin lane ids on a renamed board.
    */
    const { store, row } = harness({ column: "backlog", dependencies: [] }, RENAMED_IR);

    await run(store, { dependencies: ["FN-2"] });

    expect(row.column).toBe("inbox");
    expect(store.emit).toHaveBeenCalledWith(
      "task:moved",
      expect.objectContaining({
        from: "backlog",
        to: "inbox",
        source: "engine",
        lanes: expect.objectContaining({
          hold: "backlog",
          intake: "inbox",
          wip: "building",
          review: "signoff",
          complete: "shipped",
        }),
      }),
    );
    expect((store as any).laneCache.set).toHaveBeenCalledWith(
      "FN-1",
      expect.objectContaining({ hold: "backlog", intake: "inbox" }),
    );
  });

  it("leaves the column ALONE when the workflow cannot be resolved", async () => {
    // No literal fallback for the destination: refusing to move is recoverable, writing a column
    // that may not exist is not.
    const { store, row } = harness({ column: "todo", dependencies: [] }, undefined);

    await run(store, { dependencies: ["FN-2"] });

    expect(row.column).toBe("todo");
  });
});

describe("unassignment clears the paused STATUS in the board's own active lanes", () => {
  it("clears it for a card in a RENAMED wip lane", async () => {
    // Pre-fix: `building` matched neither literal, so the card kept status "paused" after the pause
    // itself was lifted — not paused, but saying so in every status-driven surface.
    const { store, row } = harness(
      { column: "building", status: "paused", paused: true, pausedByAgentId: "AG-1", assignedAgentId: "AG-1" },
      RENAMED_IR,
    );

    await run(store, { assignedAgentId: null });

    expect(row.status).toBeUndefined();
  });
});
