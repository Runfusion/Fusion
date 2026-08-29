import { describe, expect, it } from "vitest";
import { archiveEntryToTask } from "../task-store/serialization.js";
import type { ArchivedTaskEntry } from "../types/mesh/archive-planning.js";

describe("archiveEntryToTask", () => {
  const entry = {
    id: "FN-8561",
    lineageId: "lineage-8561",
    description: "Archived task",
    column: "archived",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
    columnMovedAt: "2026-07-22T10:00:00.000Z",
    executionCompletedAt: "2026-07-23T10:00:00.000Z",
    archivedAt: "2026-07-24T10:00:00.000Z",
  } as ArchivedTaskEntry;

  it.each([false, true])("preserves distinct lifecycle timestamps in slim=%s payloads", (slim) => {
    const task = archiveEntryToTask(entry, slim);

    expect(task.column).toBe("archived");
    expect(task.columnMovedAt).toBe("2026-07-22T10:00:00.000Z");
    expect(task.executionCompletedAt).toBe("2026-07-23T10:00:00.000Z");
    expect(task.archivedAt).toBe("2026-07-24T10:00:00.000Z");
  });

  it("keeps legacy and active-compatible payloads readable without archivedAt", () => {
    const legacy = archiveEntryToTask({ ...entry, archivedAt: undefined } as unknown as ArchivedTaskEntry);
    expect(legacy.archivedAt).toBeUndefined();
  });
});
