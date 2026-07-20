import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordRunAuditEventAsync, softDeleteTaskRowAsync } = vi.hoisted(() => ({
  recordRunAuditEventAsync: vi.fn().mockResolvedValue(undefined),
  softDeleteTaskRowAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../task-store/async-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/async-audit.js")>()),
  recordRunAuditEvent: recordRunAuditEventAsync,
}));
vi.mock("../task-store/async-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/async-persistence.js")>()),
  softDeleteTaskRow: softDeleteTaskRowAsync,
}));

import { TombstonedTaskResurrectionError } from "../task-store/errors.js";
import { _maybeAutoArchiveSameAgentDuplicateBackendImpl } from "../task-store/remaining-ops-2.js";
import { resolveSameAgentDuplicateIntake } from "../task-store/task-creation.js";

const NOW = new Date().toISOString();
const task = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: "Repair same-agent intake policy",
  description: "Ensure same-agent duplicate tasks stay visible for human review",
  column: "triage",
  createdAt: NOW,
  sourceAgentId: "agent-intake",
  sourceParentTaskId: null,
  sourceMetadata: {},
  ...overrides,
});

function createStore(overrides: Record<string, unknown> = {}) {
  const store = {
    backendMode: false,
    isWatching: false,
    asyncLayer: { db: {} },
    taskCache: new Map(),
    getSettings: vi.fn().mockResolvedValue({ autoArchiveDuplicateTasksEnabled: false, tombstoneStickyWindowDays: 7 }),
    listTasks: vi.fn().mockResolvedValue([]),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordActivity: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    insertRunAuditEventRow: vi.fn(),
    deleteTaskById: vi.fn(),
    taskDir: vi.fn().mockReturnValue("/path-that-does-not-exist"),
    ...overrides,
  };
  return store;
}

describe("same-agent duplicate intake policy (FN-8401)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing when no provenance handle is present", async () => {
    const store = createStore();
    const noProvenance = task("FN-NEW", { sourceAgentId: null, sourceParentTaskId: null });

    await resolveSameAgentDuplicateIntake(store as any, noProvenance as any, noProvenance as any);

    expect(store.listTasks).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("flags the new live duplicate in place and never deletes its sibling by default", async () => {
    const sibling = task("FN-SIBLING", { createdAt: new Date(Date.now() - 60_000).toISOString() });
    const created = task("FN-NEW");
    const store = createStore({ listTasks: vi.fn().mockResolvedValue([created, sibling]) });

    /*
    FNXC:SameAgentDuplicateIntake 2026-07-19-16:33:
    The production backend wrapper must remain thin so it cannot reintroduce the
    former delete-on-match behavior independently of the shared resolver.
    */
    await _maybeAutoArchiveSameAgentDuplicateBackendImpl(store as any, created as any, created as any);

    expect(store.updateTask).toHaveBeenCalledWith("FN-NEW", {
      sourceMetadataPatch: expect.objectContaining({ nearDuplicateOf: "FN-SIBLING" }),
    });
    expect(store.recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-NEW", metadata: expect.objectContaining({ source: "same-agent-flagged" }),
    }));
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.deleteTaskById).not.toHaveBeenCalled();
    expect((store as any).deleteTask).toBeUndefined();
    expect(created.column).toBe("triage");
  });

  it("archives only the new task when the legacy setting is explicitly enabled", async () => {
    const sibling = task("FN-SIBLING", { createdAt: new Date(Date.now() - 60_000).toISOString() });
    const created = task("FN-NEW");
    const store = createStore({
      getSettings: vi.fn().mockResolvedValue({ autoArchiveDuplicateTasksEnabled: true, tombstoneStickyWindowDays: 7 }),
      listTasks: vi.fn().mockResolvedValue([created, sibling]),
    });

    await resolveSameAgentDuplicateIntake(store as any, created as any, created as any);

    expect(store.moveTask).toHaveBeenCalledWith("FN-NEW", "archived");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-SIBLING", "archived");
    expect(store.deleteTaskById).not.toHaveBeenCalled();
    expect(created.column).toBe("archived");
  });

  it("uses backend-safe tombstone reads and rejects a sticky same-agent resurrection", async () => {
    const deletedAt = new Date(Date.now() - 60_000).toISOString();
    const tombstone = task("FN-TOMBSTONE", { deletedAt, allowResurrection: false });
    const created = task("FN-NEW");
    const store = createStore({ backendMode: true, listTasks: vi.fn().mockResolvedValue([created, tombstone]) });

    await expect(resolveSameAgentDuplicateIntake(store as any, created as any, created as any))
      .rejects.toBeInstanceOf(TombstonedTaskResurrectionError);

    /*
    FNXC:SameAgentDuplicateIntake 2026-07-19-16:40:
    Soft deletes move to `archived`; sticky tombstones require both flags so
    same-agent recreation is rejected on every persistence backend.
    */
    expect(store.listTasks).toHaveBeenCalledWith({ slim: true, includeArchived: true, includeDeleted: true });
    expect(recordRunAuditEventAsync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      taskId: "FN-NEW", mutationType: "intake:resurrection-blocked",
    }));
    expect(softDeleteTaskRowAsync).toHaveBeenCalledWith((store as any).asyncLayer, "FN-NEW", expect.any(String));
    expect(store.deleteTaskById).not.toHaveBeenCalled();
  });
});
