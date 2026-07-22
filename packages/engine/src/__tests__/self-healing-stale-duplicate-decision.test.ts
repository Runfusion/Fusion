import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";

const { recordRunAuditEventMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async () => undefined),
}));
vi.mock("../util/run-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/run-audit.js")>();
  return {
    ...actual,
    createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock, git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() })),
  };
});

import { SelfHealingManager } from "../self-healing.js";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function stranded(id: string, canonicalId: string, overrides: Partial<Task> = {}): Task {
  return task(id, {
    paused: true,
    pausedReason: "duplicate-decision-required",
    sourceMetadata: { duplicateSource: "triage-marker", nearDuplicateOf: canonicalId },
    ...overrides,
  });
}

function storeFor(tasks: Task[]): TaskStore & EventEmitter {
  const tasksById = new Map(tasks.map((entry) => [entry.id, entry]));
  return Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    listTasks: vi.fn(async () => [...tasksById.values()]),
    getTask: vi.fn(async (id: string) => tasksById.get(id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task> & { sourceMetadataPatch?: Record<string, unknown> }) => {
      const current = tasksById.get(id)!;
      const next = {
        ...current,
        ...patch,
        sourceMetadata: patch.sourceMetadataPatch ? { ...current.sourceMetadata, ...patch.sourceMetadataPatch } : current.sourceMetadata,
      } as Task;
      tasksById.set(id, next);
      return next;
    }),
  }) as unknown as TaskStore & EventEmitter;
}

describe("FN-8356: reconcile stale duplicate-decision pauses", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears the FN-8353-shaped hidden decision for every inactive canonical state and audits each recovery", async () => {
    const done = task("FN-DONE", { column: "done" });
    const archived = task("FN-ARCHIVED", { column: "archived" });
    const deleted = task("FN-DELETED", { deletedAt: new Date().toISOString() });
    const tasks = [
      stranded("FN-1", done.id), done,
      stranded("FN-2", archived.id), archived,
      stranded("FN-3", deleted.id), deleted,
      stranded("FN-4", "FN-MISSING"),
    ];
    const store = storeFor(tasks);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileStaleDuplicateDecisionPause()).toBe(4);
    for (const id of ["FN-1", "FN-2", "FN-3", "FN-4"]) {
      const recovered = await store.getTask(id);
      expect(recovered?.paused).toBe(false);
      expect(recovered?.pausedReason).toBeNull();
      expect(recovered?.sourceMetadata?.nearDuplicateDismissed).toBe(true);
      // TaskCard and NotificationService both key their decision affordance on this predicate.
      expect(recovered?.pausedReason === "duplicate-decision-required").toBe(false);
    }
    expect(recordRunAuditEventMock).toHaveBeenCalledTimes(4);
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:reconcile-stale-duplicate-decision",
      metadata: expect.objectContaining({ priorPausedReason: "duplicate-decision-required" }),
    }));
  });

  it("leaves active canonical decisions, user pauses, unrelated reasons, and non-marker sources untouched", async () => {
    const active = task("FN-ACTIVE", { column: "todo" });
    const activeDecision = stranded("FN-1", active.id);
    const userPaused = stranded("FN-2", "FN-MISSING", { userPaused: true });
    const unrelatedPause = stranded("FN-3", "FN-MISSING", { pausedReason: "awaiting-approval" });
    const nonMarker = stranded("FN-4", "FN-MISSING", { sourceMetadata: { duplicateSource: "other", nearDuplicateOf: "FN-MISSING" } });
    const store = storeFor([active, activeDecision, userPaused, unrelatedPause, nonMarker]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileStaleDuplicateDecisionPause()).toBe(0);
    for (const entry of [activeDecision, userPaused, unrelatedPause, nonMarker]) {
      expect(await store.getTask(entry.id)).toMatchObject({ paused: true, pausedReason: entry.pausedReason });
    }
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
  });
});
