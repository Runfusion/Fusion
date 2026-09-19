import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../store.js";
import type { ArchivedTaskEntry, Task } from "../types.js";

/*
FNXC:ArchiveLogAttribution 2026-09-19-07:22:
BEHAVIOURAL COVERAGE THROUGH THE SHARED ARCHIVE FUNNELS.

`archive-entry-log-attribution.test.ts` pins the action string at `taskToArchiveEntryImpl`, which is
one node in the chain. It cannot see whether `archiveTask`, `archiveAllDone`, or
`archiveTaskAndCleanup` preserve the audit context on the way down, and it cannot see which column
the archive transaction ends up recording — so a dropped handoff failed nothing.

These cases drive the real funnels, the real forwarding, and the real entry builder, and assert the
snapshot that reaches cold storage: its `Task archived from <column> by <callerKind> (<agentId>)`
line and its `preArchiveColumn`. The database transaction is the ONE doubled boundary, and the
double is contract-faithful — it applies `entryForOriginColumn` exactly as
`archiveParentTaskWithLineageGate` does, against a column that deliberately differs from the
pre-transaction read, so a fix that stopped re-anchoring would fail here rather than pass.
*/

const gate = vi.hoisted(() => ({
  stored: [] as Array<{ entry: ArchivedTaskEntry; stored: ArchivedTaskEntry }>,
  /** The row the archive TRANSACTION reads, deliberately different from the pre-transaction read. */
  liveColumn: "in progress",
  /** When set, the doubled transaction reports the authoritative row as gone (concurrent delete). */
  missingRow: false,
}));

vi.mock("../task-store/async/async-archive-lineage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../task-store/async/async-archive-lineage.js")>();
  return {
    ...actual,
    archiveParentTaskWithLineageGate: async (
      _layer: unknown,
      _taskId: string,
      entry: ArchivedTaskEntry,
      options: { entryForOriginColumn?: (originColumn: string) => ArchivedTaskEntry } = {},
    ) => {
      if (gate.missingRow) return { archived: false as const, missingRow: true as const };
      const stored = options.entryForOriginColumn
        ? options.entryForOriginColumn(gate.liveColumn)
        : entry;
      gate.stored.push({ entry, stored });
      return { archived: true as const, entry: stored };
    },
  };
});

const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  store: TaskStore;
  seed: (id: string, column: string, extra?: Record<string, unknown>) => void;
}

/**
 * A REAL `TaskStore` — every funnel, the entry builder, the archive backend, and the cold-storage
 * handoff are the production implementations. Only the I/O the archive path reaches outward for is
 * doubled: the row reads, the workflow definition reads, prompt/agent-log reads, and the
 * filesystem disposer.
 */
function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "fusi-008-archive-funnel-"));
  scratchRoots.push(root);
  const tasks = new Map<string, Task>();
  const store = Object.create(TaskStore.prototype) as Record<string, unknown>;

  store.asyncLayer = { projectId: "default" };
  // `isWatching` is `this.watcher !== null`; both it and the cache it guards are ordinary fields.
  store.watcher = null;
  store.taskCache = new Map();
  store.emit = () => true;
  store.laneCache = { set: () => undefined, invalidate: () => undefined };
  store.taskDir = () => join(root, "tasks", "scratch");
  store.getTask = async (id: string) => tasks.get(id);
  store.getSettingsFast = async () => ({});
  store.readPromptForArchive = async () => null;
  store.buildArchivedAgentLogFields = async () => ({});
  store.getTaskWorkflowSelectionAsync = async () => undefined;
  store.getWorkflowDefinition = async () => undefined;
  store.listWorkflowDefinitions = async () => [];
  store.listTasks = async ({ column }: { column: string }) =>
    [...tasks.values()].filter((task) => task.column === column);
  store.cleanupBranchForTask = async () => undefined;
  store.clearNearDuplicateReferencesToFailSoft = async () => undefined;
  store.logEntry = async () => undefined;

  return {
    store: store as unknown as TaskStore,
    seed: (id, column, extra = {}) => {
      tasks.set(id, {
        id,
        title: id,
        description: "",
        column,
        dependencies: [],
        steps: [],
        currentStep: 0,
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-02T10:00:00.000Z",
        ...extra,
      } as unknown as Task);
    },
  };
}

const actions = () => gate.stored.map(({ stored }) => stored.log[0].action);

describe("archive funnels carry the audit context into the cold snapshot", () => {
  it("attributes the single `archiveTask` funnel from the row the transaction read", async () => {
    gate.stored.length = 0;
    gate.liveColumn = "in progress";
    const h = harness();
    h.seed("FN-1", "done");

    const returned = await h.store.archiveTask("FN-1", {
      cleanup: false,
      auditContext: { agentId: "engine", runId: "auto-archive-FN-1-1", callerKind: "engine" },
    });

    expect(gate.stored).toHaveLength(1);
    // The pre-transaction read said `done`; the transaction read `in progress`. The snapshot that
    // reaches cold storage — and the task handed back — must both name the authoritative column.
    expect(actions()).toEqual(["Task archived from in progress by engine (engine)"]);
    expect(gate.stored[0].stored.preArchiveColumn).toBe("in progress");
    expect(gate.stored[0].stored.column).toBe("archived");
    expect((returned as unknown as { preArchiveColumn?: string }).preArchiveColumn).toBe("in progress");
  });

  it("attributes EVERY task the bulk `archiveAllDone` sweep archives", async () => {
    gate.stored.length = 0;
    gate.liveColumn = "shipped";
    const h = harness();
    h.seed("FN-1", "done");
    h.seed("FN-2", "done");

    const archived = await h.store.archiveAllDone({
      auditContext: { agentId: "operator", runId: "dashboard-archive-all-1", callerKind: "operator-ui" },
    });

    // A per-task dropped handoff — one card losing the context on the way down — fails here.
    expect(archived.map((task) => task.id).sort()).toEqual(["FN-1", "FN-2"]);
    expect(gate.stored).toHaveLength(2);
    expect(actions()).toEqual([
      "Task archived from shipped by operator-ui (operator)",
      "Task archived from shipped by operator-ui (operator)",
    ]);
    expect(gate.stored.map(({ stored }) => stored.preArchiveColumn)).toEqual(["shipped", "shipped"]);
  });

  it("attributes the `archiveTaskAndCleanup` cleanup funnel", async () => {
    gate.stored.length = 0;
    gate.liveColumn = "in progress";
    const h = harness();
    h.seed("FN-1", "done");

    await h.store.archiveTaskAndCleanup("FN-1", {
      agentId: "cli",
      runId: "cli-archive-FN-1-1",
      callerKind: "operator-cli",
    });

    expect(actions()).toEqual(["Task archived from in progress by operator-cli (cli)"]);
    expect(gate.stored[0].stored.preArchiveColumn).toBe("in progress");
  });

  it("keeps the api-unattributed/system fallback for a caller that passes no audit context", async () => {
    gate.stored.length = 0;
    gate.liveColumn = "in progress";
    const h = harness();
    h.seed("FN-1", "done");

    await h.store.archiveTask("FN-1", { cleanup: false });

    expect(actions()).toEqual(["Task archived from in progress by api-unattributed (system)"]);
  });

  it("does not overwrite already-captured pre-archive history with this archive's origin", async () => {
    gate.stored.length = 0;
    gate.liveColumn = "in progress";
    const h = harness();
    // A restored card re-archived from a different lane keeps the lane it was FIRST archived from:
    // that value is durable history, not a copy of this request's read.
    h.seed("FN-1", "done", { preArchiveColumn: "todo" });

    await h.store.archiveTask("FN-1", {
      cleanup: false,
      auditContext: { agentId: "engine", runId: "auto-archive-FN-1-2", callerKind: "engine" },
    });

    expect(gate.stored[0].stored.preArchiveColumn).toBe("todo");
    // The action line still reports THIS archive's origin — it is a log of this event, not history.
    expect(actions()).toEqual(["Task archived from in progress by engine (engine)"]);
  });

  it("reports a conflict instead of success when the row is gone at the transaction", async () => {
    gate.stored.length = 0;
    const h = harness();
    h.seed("FN-1", "done");
    // The transaction's authoritative read finds no live row — a concurrent delete won the race.
    // A success here would file a phantom snapshot built from the pre-transaction read.
    gate.missingRow = true;
    try {
      await expect(h.store.archiveTask("FN-1", {
        cleanup: false,
        auditContext: {agentId: "engine", runId: "auto-archive-FN-1-9", callerKind: "engine"},
      })).rejects.toThrow(/was deleted before the archive transaction/);
    } finally {
      gate.missingRow = false;
    }
  });
});
