import { describe, expect, it, vi } from "vitest";
import {
  archiveLogActionForOriginColumn,
  taskToArchiveEntryImpl,
  withAuthoritativeArchiveOriginColumn,
} from "../task-store/archive-lifecycle-2.js";
import { archiveParentTaskWithLineageGate } from "../task-store/async/async-archive-lineage.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import type { ArchivedTaskEntry } from "../types.js";
import type { TaskStore } from "../store.js";
import type { Task } from "../types.js";

const rowGate = vi.hoisted(() => ({
  /** The row the archive transaction's forensic read returns (undefined = physically absent). */
  row: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../task-store/async/async-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/async/async-persistence.js")>()),
  readTaskRowInTransaction: async () => rowGate.row,
  softDeleteTaskRowInTransaction: async () => true,
}));

vi.mock("../task-store/async/async-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/async/async-lifecycle.js")>()),
  findLiveLineageChildren: async () => [],
}));

vi.mock("../task-store/task-advisory-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/task-advisory-lock.js")>()),
  acquireTaskAdvisoryXactLock: async () => undefined,
}));

/*
FNXC:ArchiveLogAttribution 2026-09-04-11:50:
The cold snapshot used to record a single anonymous `Task archived` entry, so an engine
retention sweep and an operator's manual archive were indistinguishable after the fact.
These tests pin the attributed action string at the one funnel every archive path
routes through.
*/
describe("taskToArchiveEntryImpl archive log attribution", () => {
  const stubStore = {
    getSettingsFast: async () => ({}),
    readPromptForArchive: async () => null,
    buildArchivedAgentLogFields: async () => ({}),
  } as unknown as TaskStore;

  const task = {
    id: "FN-9001",
    title: "Archive attribution fixture",
    description: "",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
  } as unknown as Task;

  const archivedAt = "2026-09-04T12:00:00.000Z";

  it("records caller class, agent, and origin column when an audit context is supplied", async () => {
    const entry = await taskToArchiveEntryImpl(stubStore, task, archivedAt, {
      agentId: "engine",
      runId: `auto-archive-FN-9001-1`,
      callerKind: "engine",
    });
    expect(entry.log).toHaveLength(1);
    expect(entry.log[0].timestamp).toBe(archivedAt);
    expect(entry.log[0].action).toBe("Task archived from done by engine (engine)");
  });

  it("falls back to api-unattributed/system when no audit context is passed (legacy callers)", async () => {
    const entry = await taskToArchiveEntryImpl(stubStore, task, archivedAt);
    expect(entry.log).toHaveLength(1);
    expect(entry.log[0].action).toBe("Task archived from done by api-unattributed (system)");
  });

  it("reflects the pre-archive column, not the archive lane", async () => {
    const wip = { ...task, column: "in progress" } as unknown as Task;
    const entry = await taskToArchiveEntryImpl(stubStore, wip, archivedAt, {
      agentId: "cli",
      runId: "cli-archive-FN-9001-1",
      callerKind: "operator-cli",
    });
    expect(entry.log[0].action).toBe("Task archived from in progress by operator-cli (cli)");
    expect(entry.column).toBe("archived");
  });

  /*
  FNXC:ArchiveLogAttribution 2026-09-19-07:22:
  The initial build reads the CALLER's column; the snapshot that commits is re-anchored onto the row
  the archive transaction read. These cases pin the re-anchor itself, and pin that the two call
  sites format the action string identically — a second, drifting formatter would make the same
  archive produce two different lines depending on whether a move landed mid-archive.

  The end-to-end behaviour (which column actually reaches cold storage through each funnel) is
  covered in `archive-funnel-attribution.test.ts`.
  */
  describe("re-anchoring the snapshot onto the archive transaction's row", () => {
    const builtEntry = async () => await taskToArchiveEntryImpl(stubStore, task, archivedAt, {
      agentId: "engine",
      runId: "auto-archive-FN-9001-1",
      callerKind: "engine",
    });

    it("is the same formatter the initial build uses", () => {
      expect(archiveLogActionForOriginColumn("done", { agentId: "engine", runId: "r", callerKind: "engine" }))
        .toBe("Task archived from done by engine (engine)");
      expect(archiveLogActionForOriginColumn("done")).toBe("Task archived from done by api-unattributed (system)");
    });

    it("replaces the origin column and the action line with the authoritative read", async () => {
      const entry = await builtEntry();

      const reanchored = withAuthoritativeArchiveOriginColumn(
        entry,
        "in progress",
        { agentId: "engine", runId: "auto-archive-FN-9001-1", callerKind: "engine" },
        { reanchorPreArchiveColumn: true },
      );

      // The stale read said `done`; the transaction read `in progress`. Both origin carriers must
      // name the lane the commit landed under, and the archive marker must survive untouched.
      expect(reanchored.log[0].action).toBe("Task archived from in progress by engine (engine)");
      expect(reanchored.preArchiveColumn).toBe("in progress");
      expect(reanchored.column).toBe("archived");
      expect(reanchored.archivedAt).toBe(archivedAt);
      // The log timestamp stays the archive's own, not the re-anchor's.
      expect(reanchored.log[0].timestamp).toBe(archivedAt);
    });

    it("keeps captured history instead of overwriting it with this archive's origin", async () => {
      const entry = await builtEntry();

      const reanchored = withAuthoritativeArchiveOriginColumn(
        entry,
        "in progress",
        { agentId: "engine", runId: "auto-archive-FN-9001-2", callerKind: "engine" },
        { reanchorPreArchiveColumn: false },
      );

      // `preArchiveColumn` supplied by the caller is durable history; it is carried through as-is.
      expect(reanchored.preArchiveColumn).toBe("done");
      // The action line still logs THIS archive's origin, which is not history.
      expect(reanchored.log[0].action).toBe("Task archived from in progress by engine (engine)");
    });

    it("keeps the legacy fallback when the archive had no audit context", async () => {
      const entry = await taskToArchiveEntryImpl(stubStore, task, archivedAt);

      const reanchored = withAuthoritativeArchiveOriginColumn(
        entry,
        "in progress",
        undefined,
        { reanchorPreArchiveColumn: true },
      );

      expect(reanchored.log[0].action).toBe("Task archived from in progress by api-unattributed (system)");
    });

    it("returns a new entry rather than mutating the pre-transaction one", async () => {
      const entry = await builtEntry();
      const before = { ...entry, log: [...entry.log] } as ArchivedTaskEntry;

      withAuthoritativeArchiveOriginColumn(entry, "in progress", undefined, { reanchorPreArchiveColumn: true });

      expect(entry.log[0].action).toBe(before.log[0].action);
      expect(entry.preArchiveColumn).toBe(before.preArchiveColumn);
    });
  });
});

/*
FNXC:ArchiveLogAttribution 2026-09-23-23:01:
THE LIVE-ROW CHECK THE RE-ANCHOR DEPENDS ON. The gate's transactional read is forensic
(`includeDeleted: true`), so a task deleted inside the archive window still returns a row — one that
carries `deletedAt` and the soft-delete's physical `archived` state marker in `column`. Treating
that row as a re-anchor target recorded the delete's own marker as the origin column and re-archived
a row the delete already claimed. For a caller that asked for the authoritative column, an
UN-ANCHORABLE row — soft-deleted or physically absent — is `missingRow`, never a re-anchor and never
a fallback to the stale entry. Callers without a re-anchor keep their established fallback to
`entry`, deleted rows included.
*/
describe("archiveParentTaskWithLineageGate live-row check for re-anchoring", () => {
  /*
  FNXC:ArchiveLogAttribution 2026-09-23-21:55:
  Every cold-storage write in this transaction goes through `tx.insert` (the archived_tasks upsert
  in `upsertArchivedTaskEntry`), so the recorder is how a case proves NOTHING reached cold storage.
  */
  const coldWrites: unknown[] = [];
  const layer = {
    projectId: "default",
    transactionImmediate: async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        insert: (table: unknown) => {
          coldWrites.push(table);
          return { values: () => ({ onConflictDoUpdate: async () => undefined }) };
        },
      }),
  } as unknown as AsyncDataLayer;

  const entry = {
    id: "FN-9001",
    column: "archived",
    title: "re-anchor fixture",
    description: "",
    comments: [],
    archivedAt: "2026-09-23T12:00:00.000Z",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
  } as unknown as ArchivedTaskEntry;

  it("returns missingRow instead of archiving when the row is soft-deleted and the caller re-anchors", async () => {
    rowGate.row = { id: "FN-9001", column: "archived", deletedAt: "2026-09-23T11:00:00.000Z" };
    const reanchor = vi.fn((_column: string) => entry);

    const result = await archiveParentTaskWithLineageGate(layer, "FN-9001", entry, { entryForOriginColumn: reanchor });

    expect(result).toEqual({ archived: false, missingRow: true });
    // The deleted row's `archived` state marker must never become an origin column.
    expect(reanchor).not.toHaveBeenCalled();
  });

  it("returns missingRow when the row is physically absent and the caller re-anchors", async () => {
    rowGate.row = undefined;

    const result = await archiveParentTaskWithLineageGate(layer, "FN-9001", entry, {
      entryForOriginColumn: (_column: string) => entry,
    });

    expect(result).toEqual({ archived: false, missingRow: true });
  });

  /*
  FNXC:ArchiveLogAttribution 2026-09-23-21:55:
  FN-5893: the CONFLICT MUST PRECEDE ANY COLD WRITE. Reporting `missingRow` after having filed the
  snapshot would leave the phantom entry in cold storage — the very pre-transaction snapshot the
  guard exists to stop writing, for a task that is gone. Both un-anchorable shapes (soft-deleted and
  physically absent) must leave the transaction's cold storage untouched.
  */
  it("writes NO cold snapshot before reporting missingRow (soft-deleted or physically absent)", async () => {
    for (const row of [
      { id: "FN-9001", column: "archived", deletedAt: "2026-09-23T11:00:00.000Z" },
      undefined,
    ] as Array<Record<string, unknown> | undefined>) {
      rowGate.row = row;
      coldWrites.length = 0;

      const result = await archiveParentTaskWithLineageGate(layer, "FN-9001", entry, {
        entryForOriginColumn: (_column: string) => entry,
      });

      expect(result).toEqual({ archived: false, missingRow: true });
      expect(coldWrites).toHaveLength(0);
    }
  });

  it("re-anchors onto the row's column when the row is alive", async () => {
    rowGate.row = { id: "FN-9001", column: "in progress", deletedAt: null };
    const reanchored = { ...entry, preArchiveColumn: "in progress" } as unknown as ArchivedTaskEntry;
    const reanchor = vi.fn((_column: string) => reanchored);

    const result = await archiveParentTaskWithLineageGate(layer, "FN-9001", entry, { entryForOriginColumn: reanchor });

    expect(reanchor).toHaveBeenCalledWith("in progress");
    expect(reanchor).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ archived: true, entry: reanchored, originColumn: "in progress" });
  });

  it("keeps the fallback to `entry` for a caller without a re-anchor, even on a soft-deleted row", async () => {
    rowGate.row = { id: "FN-9001", column: "archived", deletedAt: "2026-09-23T11:00:00.000Z" };

    const result = await archiveParentTaskWithLineageGate(layer, "FN-9001", entry, {});

    // `originColumn` reports what the locked read saw (here the delete's `archived` marker) on
    // this legacy fallback path; only the snapshot keeps the `entry` fallback, and re-anchor
    // callers never reach this shape (they get `missingRow`).
    expect(result).toEqual({ archived: true, entry, originColumn: "archived" });
  });

  it("keeps the fallback to `entry` for a caller without a re-anchor when the row is absent", async () => {
    rowGate.row = undefined;

    const result = await archiveParentTaskWithLineageGate(layer, "FN-9001", entry, {});

    // The absent row yields no origin: the snapshot keeps the caller's `entry` and the result
    // reports `originColumn: undefined`.
    expect(result).toEqual({ archived: true, entry, originColumn: undefined });
  });
});
