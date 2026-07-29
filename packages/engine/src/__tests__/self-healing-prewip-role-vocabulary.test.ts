import { describe, expect, it, vi } from "vitest";
import "@fusion/core"; // register built-in traits
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
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
  it("resolves triage/todo for the built-in coding workflow (byte-identical to the literals)", async () => {
    const manager = managerFor(storeFor()) as unknown as Internals;
    const columns = await manager.resolvePreWipColumns("FN-1", new Map());
    expect(columns).toEqual({ intake: "triage", hold: "todo" });
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
  Recovery sweeps must keep working when a workflow cannot be read. Returning
  nothing would drop the card out of EVERY converted sweep — a silent loss of
  recovery, which is worse than continuing with the legacy vocabulary. Deliberately
  different from conversions whose failure mode is a destructive move.
  */
  it("falls back to the legacy vocabulary when the workflow cannot be resolved", async () => {
    const throwingStore = {
      getTaskWorkflowSelection: vi.fn(() => { throw new Error("unreadable"); }),
      getTaskWorkflowSelectionAsync: vi.fn(async () => { throw new Error("unreadable"); }),
      getWorkflowDefinition: vi.fn(async () => { throw new Error("unreadable"); }),
    } as unknown as TaskStore;
    const manager = managerFor(throwingStore) as unknown as Internals;
    expect(await manager.resolvePreWipColumns("FN-1", new Map())).toEqual({ intake: "triage", hold: "todo" });
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
