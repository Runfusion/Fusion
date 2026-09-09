import { describe, expect, it, vi } from "vitest";
import { taskToArchiveEntryImpl } from "../task-store/archive-lifecycle-2.js";
import {
  ARCHIVE_FORBIDDEN_RUNTIME_FIELDS,
  ARCHIVE_RESTORABLE_TASK_FIELDS,
} from "../task-store/archive-restoration-contract.js";
import { archiveEntryToTask } from "../task-store/serialization.js";
import type { ArchivedTaskEntry, Task } from "../types.js";

function populatedEntry(): ArchivedTaskEntry {
  return {
    id: "FN-8561",
    lineageId: "lineage-8561",
    description: "Archived task",
    column: "archived",
    dependencies: [],
    steps: [],
    currentStep: 0,
    executionMode: "fast",
    plannerOversightLevel: "autonomous",
    sessionAdvisorEnabled: false,
    reviewState: { findings: [] },
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      firstUsedAt: "2026-07-20T10:01:00.000Z",
      lastUsedAt: "2026-07-20T10:02:00.000Z",
      perModel: [],
    },
    columnDwellMs: { planning: 0, "in-progress": 1250 },
    firstExecutionAt: "2026-07-20T10:00:00.000Z",
    cumulativeActiveMs: 0,
    cumulativePlanningMs: 350,
    planningStartedAt: "2026-07-20T09:00:00.000Z",
    executionStartedAt: "2026-07-20T10:00:00.000Z",
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
    columnMovedAt: "2026-07-22T10:00:00.000Z",
    executionCompletedAt: "2026-07-23T10:00:00.000Z",
    baseBranch: "main",
    branch: "fusion/fn-8561",
    baseCommitSha: "base-sha",
    modifiedFiles: [],
    mergeDetails: { commitSha: "landed-sha", filesChanged: 0, insertions: 0, deletions: 0 },
    archivedAt: "2026-07-24T10:00:00.000Z",
  } as ArchivedTaskEntry;
}

describe("archive history serialization", () => {
  it.each([false, true])("preserves durable metrics and distinct timestamps in slim=%s payloads", (slim) => {
    const entry = populatedEntry();
    const task = archiveEntryToTask(entry, slim);

    expect(task).toMatchObject({
      column: "archived",
      columnMovedAt: entry.columnMovedAt,
      executionCompletedAt: entry.executionCompletedAt,
      archivedAt: entry.archivedAt,
      executionMode: "fast",
      plannerOversightLevel: "autonomous",
      sessionAdvisorEnabled: false,
      cumulativeActiveMs: 0,
      cumulativePlanningMs: 350,
      columnDwellMs: { planning: 0, "in-progress": 1250 },
      tokenUsage: entry.tokenUsage,
      modifiedFiles: [],
      mergeDetails: entry.mergeDetails,
    });
  });

  it("writes every canonical restorable field and retains branch only as snapshot provenance", async () => {
    const task = { ...archiveEntryToTask(populatedEntry()), column: "done", branch: "fusion/fn-8561" } as Task;
    const store = {
      readPromptForArchive: vi.fn().mockResolvedValue("# Prompt"),
      buildArchivedAgentLogFields: vi.fn().mockResolvedValue({}),
    };

    const entry = await taskToArchiveEntryImpl(store as never, task, "2026-07-24T10:00:00.000Z");

    for (const field of ARCHIVE_RESTORABLE_TASK_FIELDS) {
      expect(entry[field], field).toEqual(task[field]);
    }
    expect(entry.branch).toBe("fusion/fn-8561");
  });

  it("keeps cold-only activity proofs for full and slim archive round-trips", async () => {
    const timingEvents = [
      { timestamp: "2026-07-20T10:05:00.000Z", action: "[timing] Active segment: 1250ms" },
      { timestamp: "2026-07-20T10:10:00.000Z", action: "Execution checkpoint", outcome: "[timing] Active segment: 750ms" },
    ];
    const task = {
      ...archiveEntryToTask(populatedEntry()),
      column: "done",
      log: timingEvents,
    } as Task;
    const store = {
      readPromptForArchive: vi.fn().mockResolvedValue("# Prompt"),
      buildArchivedAgentLogFields: vi.fn().mockResolvedValue({}),
    };

    const entry = await taskToArchiveEntryImpl(store as never, task, "2026-07-24T10:00:00.000Z");
    const full = archiveEntryToTask(entry, false);
    const slim = archiveEntryToTask(entry, true);

    expect(entry.log).toEqual([
      ...timingEvents,
      { timestamp: "2026-07-24T10:00:00.000Z", action: "Task deleted" },
    ]);
    expect(full.log).toEqual(entry.log);
    expect(slim.log).toEqual([]);
    expect(slim.timedExecutionMs).toBe(2000);
  });

  it("does not fabricate newer metrics for a legacy snapshot", () => {
    const entry = populatedEntry();
    for (const field of ARCHIVE_RESTORABLE_TASK_FIELDS) delete (entry as unknown as Record<string, unknown>)[field];

    const task = archiveEntryToTask(entry);

    for (const field of ARCHIVE_RESTORABLE_TASK_FIELDS) {
      expect(task[field], field).toBeUndefined();
    }
  });

  it("keeps runtime ownership outside the restoration contract", () => {
    expect(ARCHIVE_FORBIDDEN_RUNTIME_FIELDS).toEqual(expect.arrayContaining([
      "worktree",
      "workspaceWorktrees",
      "status",
      "blockedBy",
      "paused",
      "userPaused",
      "error",
    ]));
    expect(ARCHIVE_RESTORABLE_TASK_FIELDS).not.toEqual(expect.arrayContaining(ARCHIVE_FORBIDDEN_RUNTIME_FIELDS));
  });

  it("keeps legacy and active-compatible payloads readable without archivedAt", () => {
    const legacy = archiveEntryToTask({ ...populatedEntry(), archivedAt: undefined } as unknown as ArchivedTaskEntry);
    expect(legacy.archivedAt).toBeUndefined();
  });
});
