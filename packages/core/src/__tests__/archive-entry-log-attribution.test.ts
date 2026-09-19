import { describe, expect, it } from "vitest";
import {
  archiveLogActionForOriginColumn,
  taskToArchiveEntryImpl,
  withAuthoritativeArchiveOriginColumn,
} from "../task-store/archive-lifecycle-2.js";
import type { ArchivedTaskEntry } from "../types.js";
import type { TaskStore } from "../store.js";
import type { Task } from "../types.js";

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
