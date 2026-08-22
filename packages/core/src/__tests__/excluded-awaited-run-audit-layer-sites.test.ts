import { afterEach, describe, expect, it, vi } from "vitest";

const asyncAudit = vi.hoisted(() => vi.fn());
const softDelete = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const readTaskRow = vi.hoisted(() => vi.fn());
vi.mock("../task-store/async/async-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/async/async-audit.js")>()),
  recordRunAuditEvent: asyncAudit,
}));
vi.mock("../task-store/async/async-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/async/async-persistence.js")>()),
  softDeleteTaskRow: softDelete,
  readTaskRow,
}));

import { createRecallCaptureWriter } from "../memory/recall-capture.js";
import { resolveSameAgentDuplicateIntake } from "../task-store/task-creation.js";
import { maybeResolveTombstonedTaskIdImpl } from "../task-store/task-id-integrity.js";
import { TombstonedTaskResurrectionError } from "../task-store/errors.js";

/*
 * FNXC:RunAudit 2026-08-20-07:42:
 * FN-9180 routes class-A outbox rows through bounded telemetry, so this characterization retains
 * only intentionally awaited class-C and recall-capture behavior.
 */
describe("FN-9178 awaited data-layer audit characterization", () => {
  afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

  function resurrectionStore() {
    return {
      asyncLayer: { projectId: "project", db: {} }, isWatching: true, taskCache: new Map(),
      taskDir: vi.fn(() => "/definitely-absent"), getSettings: vi.fn().mockResolvedValue({ tombstoneStickyWindowDays: 7 }),
      listTasksBySourceLineage: vi.fn(),
    } as never;
  }

  it.each([
    ["absent", () => undefined, true],
    ["synchronous throw", () => { throw new Error("sync"); }, false],
    ["rejection", () => Promise.reject(new Error("reject")), false],
  ])("intake resurrection keeps destructive follow-up ordered after a %s audit", async (_state, sink, deletes) => {
    asyncAudit.mockImplementation(sink as never);
    const store = resurrectionStore();
    const deletedAt = new Date().toISOString();
    const task = { id: "FN-INTAKE", title: "new", description: "new", column: "todo", createdAt: deletedAt, sourceAgentId: "agent", sourceParentTaskId: null };
    store.listTasksBySourceLineage.mockResolvedValue([task, { ...task, id: "FN-TOMB", deletedAt, allowResurrection: false }]);
    const operation = resolveSameAgentDuplicateIntake(store, task as never, task as never);
    if (deletes) await expect(operation).rejects.toBeInstanceOf(TombstonedTaskResurrectionError);
    else await expect(operation).resolves.toBeUndefined(); // The helper fails open when forensic audit cannot land.
    expect(softDelete).toHaveBeenCalledTimes(deletes ? 1 : 0);
  });

  it("intake resurrection remains pending and cannot delete before a never-settling audit", async () => {
    const store = resurrectionStore(); const deletedAt = new Date().toISOString();
    const task = { id: "FN-never-settling", title: "new", description: "new", column: "todo", createdAt: deletedAt, sourceAgentId: "agent", sourceParentTaskId: null };
    store.listTasksBySourceLineage.mockResolvedValue([task, { ...task, id: "FN-TOMB", deletedAt, allowResurrection: false }]);
    asyncAudit.mockImplementation(() => new Promise<never>(() => undefined));
    vi.useFakeTimers(); let settled = false;
    void resolveSameAgentDuplicateIntake(store, task as never, task as never).finally(() => { settled = true; }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(softDelete).not.toHaveBeenCalled();
    expect(settled).toBe(false);
  });

  it("intake resurrection throws its typed error after a late audit permits destructive cleanup", async () => {
    const store = resurrectionStore(); const deletedAt = new Date().toISOString();
    const task = { id: "FN-late-settling", title: "new", description: "new", column: "todo", createdAt: deletedAt, sourceAgentId: "agent", sourceParentTaskId: null };
    store.listTasksBySourceLineage.mockResolvedValue([task, { ...task, id: "FN-TOMB", deletedAt, allowResurrection: false }]);
    asyncAudit.mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 2_100)));
    vi.useFakeTimers();
    const operation = resolveSameAgentDuplicateIntake(store, task as never, task as never);
    // FNXC:RunAudit 2026-08-20-07:16: Observe the deferred forensic rejection before fake-time advancement, then assert its real type.
    void operation.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(softDelete).toHaveBeenCalledOnce();
    await expect(operation).rejects.toBeInstanceOf(TombstonedTaskResurrectionError);
  });

  it.each([
    ["absent", () => undefined],
    ["synchronous throw", () => { throw new Error("sync"); }],
    ["rejection", () => Promise.reject(new Error("reject"))],
    ["never-settling", () => new Promise<never>(() => undefined)],
    ["late-settling", () => new Promise<void>((resolve) => setTimeout(resolve, 2_100))],
  ])("id-integrity resurrection preserves its typed throw after %s audit behavior", async (_state, sink) => {
    const deletedAt = new Date().toISOString();
    readTaskRow.mockResolvedValue({ deletedAt, allowResurrection: false });
    asyncAudit.mockImplementation(sink as never);
    const store = resurrectionStore();
    if (_state.includes("settling")) vi.useFakeTimers();
    const operation = maybeResolveTombstonedTaskIdImpl(store, "FN-TOMB", {}, "createTask");
    // Attach an observer immediately: fake-time advancement may settle the late audit before the
    // assertion below awaits this deliberately rejecting forensic entry point.
    void operation.catch(() => undefined);
    if (_state === "never-settling") {
      let settled = false; void operation.finally(() => { settled = true; }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(2_100); expect(settled).toBe(false);
    } else if (_state === "late-settling") {
      await vi.advanceTimersByTimeAsync(2_100);
      await expect(operation).rejects.toBeInstanceOf(TombstonedTaskResurrectionError);
    } else if (_state === "absent") {
      await expect(operation).rejects.toBeInstanceOf(TombstonedTaskResurrectionError);
    } else {
      // Unlike the intake helper, this forensic pre-throw entry lets audit failure replace its
      // typed resurrection error; that observable ordering is class-B evidence, not a fix.
      await expect(operation).rejects.toThrow(_state === "synchronous throw" ? "sync" : "reject");
    }
  });
  it.each([
    ["absent", () => undefined],
    ["synchronous throw", () => { throw new Error("sync"); }],
    ["rejection", () => Promise.reject(new Error("reject"))],
    ["never-settling", () => new Promise<never>(() => undefined)],
    ["late-settling", () => new Promise<void>((resolve) => setTimeout(resolve, 2_100))],
  ])("recall capture contains %s injected audit without unhandled rejection", async (_state, injectedAudit) => {
    const logger = { warn: vi.fn() };
    const writer = createRecallCaptureWriter({
      layer: {} as never, append: async () => ({ status: "created", record: { id: "recall-1" } }) as never,
      audit: injectedAudit as never, logger,
    });
    if (_state.includes("settling")) vi.useFakeTimers();
    writer.capture({ origin: "insight", summary: "summary", insightId: "INS-1" });
    if (_state === "never-settling") {
      await vi.advanceTimersByTimeAsync(2_100);
      expect(logger.warn).not.toHaveBeenCalled();
    } else if (_state === "late-settling") {
      await vi.advanceTimersByTimeAsync(2_100);
      await writer.flushPendingCaptures();
      expect(logger.warn).not.toHaveBeenCalled();
    } else {
      await writer.flushPendingCaptures();
      expect(logger.warn).toHaveBeenCalledTimes(_state === "absent" ? 0 : 1);
    }
  });
});
