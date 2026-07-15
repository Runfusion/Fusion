import { describe, expect, it } from "vitest";
import { changedSnapshotRows, missingSnapshotIds } from "../notifications/store.js";
import type { SnapshotRow } from "../notifications/types.js";

describe("notification snapshot deltas", () => {
  const row = (taskId: string, lastColumn: SnapshotRow["lastColumn"], updatedAt: string): SnapshotRow => ({
    taskId,
    lastColumn,
    updatedAt,
  });

  it("does not rewrite unchanged snapshot rows", () => {
    /* FNXC:EvenRealitiesPostgres 2026-07-14-17:55: An unchanged notifier poll performs no snapshot upsert; only new, moved, or updated tasks are written. */
    const existing = new Map([
      ["FN-1", row("FN-1", "todo", "2026-01-01T00:00:00.000Z")],
      ["FN-2", row("FN-2", "in-review", "2026-01-01T00:00:01.000Z")],
    ]);
    expect(changedSnapshotRows(existing, [...existing.values()])).toEqual([]);
    expect(changedSnapshotRows(existing, [
      row("FN-1", "in-progress", "2026-01-01T00:00:02.000Z"),
      row("FN-3", "todo", "2026-01-01T00:00:03.000Z"),
    ]).map(({ taskId }) => taskId)).toEqual(["FN-1", "FN-3"]);
  });

  it("derives a bounded delete set from the prior snapshot", () => {
    const existing = new Map([
      ["FN-1", row("FN-1", "todo", "2026-01-01T00:00:00.000Z")],
      ["FN-2", row("FN-2", "todo", "2026-01-01T00:00:00.000Z")],
    ]);
    expect(missingSnapshotIds(existing, new Set(["FN-2", "FN-3"]))).toEqual(["FN-1"]);
  });
});
