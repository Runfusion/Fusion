import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { isTaskReverted, findOpenUndoTaskForSource, partitionRevertedTasks } from "../taskRevert";

describe("isTaskReverted", () => {
  it.each([
    [undefined, false],
    [{}, false],
    [{ revertedAt: "" }, false],
    [{ revertedAt: "   " }, false],
    [{ revertedAt: 123 }, false],
    [{ revertedAt: true }, false],
    [{ revertedAt: "2026-07-16T00:00:00.000Z" }, true],
  ] as const)("returns %s for revertedAt metadata", (sourceMetadata, expected) => {
    expect(isTaskReverted(sourceMetadata as Task["sourceMetadata"] | undefined)).toBe(expected);
  });

  /*
  FN-416 case (i): the revert marker is revocable by an additive `restoredAt`. The table is the
  full cross-product of marker states, and every doubtful restore datum must keep the task
  reverted (fail-safe) rather than silently erasing a Reverted badge.
  */
  const REVERTED_AT = "2026-08-01T00:00:00.000Z";
  it.each([
    ["absent restoredAt", { revertedAt: REVERTED_AT }, true],
    ["blank restoredAt", { revertedAt: REVERTED_AT, restoredAt: "   " }, true],
    ["non-string restoredAt", { revertedAt: REVERTED_AT, restoredAt: 1234 }, true],
    ["boolean restoredAt", { revertedAt: REVERTED_AT, restoredAt: true }, true],
    ["unparsable restoredAt", { revertedAt: REVERTED_AT, restoredAt: "not-a-date" }, true],
    ["earlier restoredAt", { revertedAt: REVERTED_AT, restoredAt: "2026-07-01T00:00:00.000Z" }, true],
    ["equal restoredAt", { revertedAt: REVERTED_AT, restoredAt: REVERTED_AT }, false],
    ["later restoredAt", { revertedAt: REVERTED_AT, restoredAt: "2026-09-01T00:00:00.000Z" }, false],
    ["unparsable revertedAt with valid restoredAt", { revertedAt: "whenever", restoredAt: "2026-09-01T00:00:00.000Z" }, true],
    ["blank revertedAt with valid restoredAt", { revertedAt: "  ", restoredAt: "2026-09-01T00:00:00.000Z" }, false],
    ["restoredAt with no revertedAt", { restoredAt: "2026-09-01T00:00:00.000Z" }, false],
  ] as const)("revocable marker: %s", (_label, sourceMetadata, expected) => {
    expect(isTaskReverted(sourceMetadata as Task["sourceMetadata"] | undefined)).toBe(expected);
  });
});

describe("partitionRevertedTasks", () => {
  const task = (id: string, revertedAt?: unknown, restoredAt?: unknown): Task => ({
    id, column: "done", title: id, description: "", createdAt: "", updatedAt: "", dependencies: [], steps: [],
    sourceMetadata: revertedAt === undefined
      ? {}
      : { revertedAt, ...(restoredAt === undefined ? {} : { restoredAt }) },
  } as unknown as Task);

  it("keeps invalid markers normal and returns valid markers once", () => {
    const reverted = task("KB-2", "2026-08-01T00:00:00.000Z");
    const result = partitionRevertedTasks([task("KB-1", " "), reverted, reverted, task("KB-3", 42)]);
    expect(result.normal.map(({ id }) => id)).toEqual(["KB-1", "KB-3"]);
    expect(result.reverted.map(({ id }) => id)).toEqual(["KB-2"]);
  });

  // FN-416 case (i): partition follows the same revocable verdict as `isTaskReverted`.
  it("treats a restored task as normal and a stale restore marker as still reverted", () => {
    const result = partitionRevertedTasks([
      task("KB-RESTORED", "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"),
      task("KB-STALE-RESTORE", "2026-08-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"),
      task("KB-BAD-RESTORE", "2026-08-01T00:00:00.000Z", 42),
    ]);
    expect(result.normal.map(({ id }) => id)).toEqual(["KB-RESTORED"]);
    expect(result.reverted.map(({ id }) => id)).toEqual(["KB-STALE-RESTORE", "KB-BAD-RESTORE"]);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:30:
THE UNDO-TASK LOOKUP CLASSIFIED A NEIGHBOUR'S COLUMN BY ID.

`findOpenUndoTaskForSource` skips candidates that are finished, so a prior undo attempt in Complete
never renders as an active "Undo task" link. Keyed only on `done`, a board that renames Complete
matched nothing: a FINISHED undo task kept rendering as an open one, which is the stale
affordance the function's own header says it exists to prevent.

The flags are PER-CANDIDATE, keyed by task id. That is what makes this correct and what two earlier
notes said was unavailable — `TaskDetailModal` has had `columnFlagsByTaskId` as a prop all along and
already uses it this way for the near-duplicate canonical.

Both directions are asserted, and the negative is the load-bearing one: the map is fail-soft, so a
candidate it does not cover must still be treated as OPEN rather than silently skipped. A conversion
that skipped unknown candidates would hide live undo links.
*/
describe("findOpenUndoTaskForSource resolves each candidate's own lanes", () => {
  const candidate = (id: string, column: string, createdAt: string): Task => ({
    id, column, title: id, description: "", createdAt, updatedAt: createdAt,
    dependencies: [], steps: [], sourceMetadata: { revertOf: "KB-SRC" },
  } as unknown as Task);

  it("skips an undo task resting in a RENAMED complete lane", () => {
    const tasks = [candidate("KB-UNDO", "shipped", "2026-06-01T00:00:00.000Z")];
    const flags = new Map([["KB-UNDO", { complete: true }]]);

    expect(findOpenUndoTaskForSource(tasks, "KB-SRC", flags as never)).toBeUndefined();
  });

  it("still returns an undo task resting in a live lane on that same board", () => {
    const tasks = [candidate("KB-UNDO", "building", "2026-06-01T00:00:00.000Z")];
    const flags = new Map([["KB-UNDO", { countsTowardWip: true }]]);

    expect(findOpenUndoTaskForSource(tasks, "KB-SRC", flags as never)?.id).toBe("KB-UNDO");
  });

  it("treats a candidate the map does not cover as OPEN, not skipped", () => {
    /* Fail-soft in the safe direction: an unknown candidate keeps its link rather than losing it. */
    const tasks = [candidate("KB-UNDO", "building", "2026-06-01T00:00:00.000Z")];

    expect(findOpenUndoTaskForSource(tasks, "KB-SRC", new Map() as never)?.id).toBe("KB-UNDO");
  });

  it("still skips the legacy ids when no flags are supplied at all", () => {
    /* CONTROL: the parameter is optional, so an unwired caller behaves exactly as before. */
    const tasks = [candidate("KB-UNDO", "done", "2026-06-01T00:00:00.000Z")];

    expect(findOpenUndoTaskForSource(tasks, "KB-SRC")).toBeUndefined();
  });
});
