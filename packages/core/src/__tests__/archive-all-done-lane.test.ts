/*
FNXC:WorkflowLifecycleColumns 2026-08-01-05:00:

THE INVARIANT: "Archive all done" reads the board's OWN complete lane.

`listTasks({ column: "done" })` filters in the STORE, so on a renamed board this returned an empty
array and the action completed successfully having archived **zero** cards. An operator action that
silently does nothing is worse than one that errors: the board simply looks unchanged, so the natural
conclusion is that there was nothing to archive.

Census-invisible — the literal is a query filter, not a comparison — and this file had no lifecycle
comparison to convert at all.

REVERT PROOF, measured: restore `listTasks({ slim: true, column: "done" })` and the renamed case
archives nothing.
*/
import { describe, expect, it, vi } from "vitest";
import { archiveAllDoneImpl } from "../task-store/task-artifacts-ops.js";
import type { TaskStore } from "../store.js";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

function store(tasksByColumn: Record<string, unknown[]>, definitions: unknown[]) {
  const archived: string[] = [];
  const impl = {
    listWorkflowDefinitions: vi.fn(async () => definitions),
    listTasks: vi.fn(async ({ column }: { column?: string }) => column ? tasksByColumn[column] ?? [] : Object.values(tasksByColumn).flat()),
    archiveTask: vi.fn(async (id: string) => { archived.push(id); return { id } as never; }),
    logEntry: vi.fn(async () => undefined),
  } as unknown as TaskStore;
  return { impl, archived };
}

const card = (id: string, column: string) => ({ id, column, dependencies: [], steps: [] });

describe("archiveAllDone resolves the board's own complete lane", () => {
  it("archives a card sitting in a RENAMED complete lane", async () => {
    const { impl, archived } = store({ shipped: [card("FN-1", "shipped")] }, [{ ir: RENAMED_IR }]);

    const result = await archiveAllDoneImpl(impl);

    expect(result.archived.map((task) => task.id)).toEqual(["FN-1"]);
    expect(archived).toEqual(["FN-1"]);
  });

  it("still archives legacy rows, for a board mid-rename", async () => {
    // The union keeps rows stored under the old id reachable while a rename is in flight.
    const { impl, archived } = store({ done: [card("FN-2", "done")] }, [{ ir: RENAMED_IR }]);

    const result = await archiveAllDoneImpl(impl);

    expect(result.archived.map((task) => task.id)).toEqual(["FN-2"]);
    expect(archived).toEqual(["FN-2"]);
  });

  it("does not archive a card outside the complete lane", async () => {
    // The action must stay scoped — archiving everything would be its own bug.
    const { impl, archived } = store({ building: [card("FN-3", "building")] }, [{ ir: RENAMED_IR }]);

    const result = await archiveAllDoneImpl(impl);

    expect(result.archived).toEqual([]);
    expect(archived).toEqual([]);
  });
});
