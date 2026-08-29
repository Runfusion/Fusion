/*
FNXC:WorkflowLifecycleColumns 2026-07-31-13:40:

THE INVARIANT: `excludeArchived` excludes the cards the board's OWN workflow calls archived.

FOUND BY AUDITING AN UNWIRED PARAMETER ONE LEVEL UP. `rankAssignedTasksForWakeDelta` gained a
resolved terminal answer that no production caller passed. Reading that caller showed the real gap
was HERE: `getTasksByAssignedAgent`'s `excludeArchived` filtered on `column === "archived"`, so on a
renamed board archived cards came back as OPEN assigned work and the Wake Delta inventory asked a
coordinator to unblock or reassign tasks that had already been archived.

That is the fourth unwired parameter in this sweep whose CALLER held the larger defect — after
`blocker-fanout` (no warning emitted at all), the analytics routes (silent zero), and the legacy
stamp backfill (queried a column the board does not have). The parameter is the visible end; the
defect lives one level up every time.

COST NOTE: resolution runs only over rows that already matched `agentId` — a handful — not the whole
board, and shares one IR cache. Asserted below, because a per-card IR read over `listTasks()` would
be a real regression on a large board.

REVERT PROOF, measured: restore `task.column === "archived"` and the renamed-archived case fails.
*/
import { describe, expect, it, vi } from "vitest";
import { getTasksByAssignedAgentImpl } from "../task-store/branch-and-pr-entities.js";
import type { TaskStore } from "../store.js";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "vault", name: "Vault", traits: [{ trait: "archived" }] },
  ],
};

function harness(tasks: Array<Record<string, unknown>>, ir: unknown) {
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  let irReads = 0;
  const store = {
    listTasks: vi.fn(async () => tasks),
    getTaskWorkflowSelection: () => (ir ? selection : undefined),
    getTaskWorkflowSelectionAsync: async () => (ir ? selection : undefined),
    getWorkflowDefinition: async () => { irReads += 1; return ir ? { ir } : undefined; },
  } as unknown as TaskStore;
  return { store, irReads: () => irReads };
}

const card = (id: string, column: string, agent = "AG-1") => ({ id, column, assignedAgentId: agent });

describe("getTasksByAssignedAgent excludes the board's own archived lane", () => {
  it("drops a card in a RENAMED archived lane", async () => {
    // Pre-fix: `vault` !== "archived", so an archived card was returned as open assigned work.
    const { store } = harness([card("FN-LIVE", "building"), card("FN-VAULTED", "vault")], RENAMED_IR);

    const result = await getTasksByAssignedAgentImpl(store, "AG-1", { excludeArchived: true });

    expect(result.map((t) => t.id)).toEqual(["FN-LIVE"]);
  });

  it("keeps a completed-but-not-archived card, since complete is not archived", async () => {
    // The two roles are separable; excludeArchived must not quietly become excludeTerminal.
    const { store } = harness([card("FN-SHIPPED", "shipped")], RENAMED_IR);

    const result = await getTasksByAssignedAgentImpl(store, "AG-1", { excludeArchived: true });

    expect(result.map((t) => t.id)).toEqual(["FN-SHIPPED"]);
  });

  it("resolves nothing when excludeArchived is not requested", async () => {
    // The common call must not pay for resolution it did not ask for.
    const { store, irReads } = harness([card("FN-LIVE", "building")], RENAMED_IR);

    await getTasksByAssignedAgentImpl(store, "AG-1", {});

    expect(irReads()).toBe(0);
  });

  it("resolves only the agent's own rows, sharing one IR read", async () => {
    const mine = [card("FN-1", "building"), card("FN-2", "building"), card("FN-3", "building")];
    const theirs = [card("FN-X", "building", "AG-OTHER"), card("FN-Y", "building", "AG-OTHER")];
    const { store, irReads } = harness([...mine, ...theirs], RENAMED_IR);

    const result = await getTasksByAssignedAgentImpl(store, "AG-1", { excludeArchived: true });

    expect(result).toHaveLength(3);
    expect(irReads()).toBe(1);
  });

  it("keeps the legacy id when the workflow cannot be resolved", async () => {
    const { store } = harness([card("FN-LIVE", "in-progress"), card("FN-OLD", "archived")], undefined);

    const result = await getTasksByAssignedAgentImpl(store, "AG-1", { excludeArchived: true });

    expect(result.map((t) => t.id)).toEqual(["FN-LIVE"]);
  });
});
