import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../store.js";
import type { ArchivedTaskEntry, Task } from "../types.js";
import { cleanupArchivedTasksImpl } from "../task-store/task-mutation-ops.js";

/*
FNXC:ArchiveLogAttribution 2026-09-23-23:59:
CLASS INVARIANT (FN-5893) FOR THE CLEANUP REBUILD. `cleanupArchivedTasksImpl` hard-deletes archived
rows and guarantees a cold-storage snapshot first — but it rebuilt that snapshot UNCONDITIONALLY from
the tombstone: no audit context (so the line read `by api-unattributed (system)`) and the physical
`archived` marker passed off as the origin column (`Task archived from archived`). A cleanup after an
ordinary attributed archive therefore REPLACED `Task archived from done by operator-cli (cli)` with
that anonymous line, destroying the attribution the archive recorded (Devin PR-3561 bug #1).

The authoritative terminal snapshot (FNXC:ArchivedRecommendations) must survive: an existing cold
entry is preserved as-is, and a fallback is synthesized ONLY when none exists — naming its origin
from the tombstone's own history (`preArchiveColumn`), or the legacy plain action string when
history names none, never from the archive marker.
*/

const gate = vi.hoisted(() => ({
  existing: undefined as ArchivedTaskEntry | undefined,
  upserts: [] as ArchivedTaskEntry[],
}));

vi.mock("../task-store/async/async-archive-lineage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../task-store/async/async-archive-lineage.js")>();
  return {
    ...actual,
    findArchivedTaskEntry: async () => gate.existing,
    upsertArchivedTaskEntry: async (_db: unknown, entry: ArchivedTaskEntry) => {
      gate.upserts.push(entry);
    },
  };
});

/**
 * REAL `TaskStore` prototype (entry builder included) with the cleanup I/O doubled at the same
 * boundary `archive-funnel-attribution.test.ts` uses: the row read, the cold-storage helpers, and
 * the drizzle chains.
 */
function harness(tombstone: Partial<Task>) {
  const rows = [{ id: "FN-77", column: "archived", ...tombstone }];
  const db = {
    // `where()` answers the awaited row read; `.limit(1)` (the selection-purge probe) sees none,
    // so that helper early-returns and the cleanup assertions stay about the cold entry.
    select: () => ({ from: () => ({ where: () => Object.assign([...rows], { limit: async () => [] }) }) }),
    delete: () => ({ where: async () => undefined }),
  };
  const store = Object.create(TaskStore.prototype) as TaskStore & Record<string, unknown>;
  store.asyncLayer = { projectId: "default", db };
  store.watcher = null;
  store.taskCache = new Map();
  store.rowToTask = (row: Task) => row;
  store.pgRowToTaskRow = (row: Task) => row;
  store.taskDir = () => "/nonexistent/fusion-cleanup-scratch";
  store.getSettingsFast = async () => ({});
  store.readPromptForArchive = async () => null;
  store.buildArchivedAgentLogFields = async () => ({});
  store.getTaskWorkflowSelectionAsync = async () => undefined;
  store.getWorkflowDefinition = async () => undefined;
  store.listWorkflowDefinitions = async () => [];
  return store;
}

const cleanupRun = async (tombstone: Partial<Task>) => {
  gate.upserts = [];
  return cleanupArchivedTasksImpl(harness(tombstone));
};

describe("cleanupArchivedTasks keeps archive attribution intact", () => {
  beforeEach(() => {
    gate.existing = undefined;
  });

  it("preserves the existing attributed cold entry instead of rebuilding it from the tombstone", async () => {
    gate.existing = {
      id: "FN-77",
      preArchiveColumn: "done",
      archivedAt: "2026-09-23T10:00:00.000Z",
      log: [{ timestamp: "2026-09-23T10:00:00.000Z", action: "Task archived from done by operator-cli (cli)" }],
    } as ArchivedTaskEntry;

    const cleaned = await cleanupRun({ deletedAt: "2026-09-23T10:00:00.000Z" });

    expect(cleaned).toEqual(["FN-77"]);
    // Pre-fix: the rebuild upserted a fresh entry and overwrote the attributed one.
    expect(gate.upserts).toHaveLength(0);
  });

  it("synthesizes a fallback naming the historical origin column only when no entry exists", async () => {
    const cleaned = await cleanupRun({
      preArchiveColumn: "done",
      deletedAt: "2026-09-23T10:00:00.000Z",
    });

    expect(cleaned).toEqual(["FN-77"]);
    expect(gate.upserts).toHaveLength(1);
    // Pre-fix: `Task archived from archived by api-unattributed (system)` — the archive marker
    // passed off as a live origin.
    expect(gate.upserts[0]?.log?.[0]?.action).toBe("Task archived from done by api-unattributed (system)");
  });

  it("falls back to the legacy plain action when history names no origin", async () => {
    await cleanupRun({ deletedAt: "2026-09-23T10:00:00.000Z" });

    expect(gate.upserts).toHaveLength(1);
    // Pre-fix: same fabricated `Task archived from archived ...` line even with zero history.
    expect(gate.upserts[0]?.log?.[0]?.action).toBe("Task archived");
  });
});
