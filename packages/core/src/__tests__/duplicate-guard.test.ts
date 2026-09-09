import { describe, expect, it, vi } from "vitest";

import type { Column, Task } from "../types.js";
import type { TaskStore } from "../store.js";
import { computeContentFingerprint } from "../duplicates/duplicate-detection.js";
import { resolveFingerprintWindowMs } from "../task-store/branch-and-pr-entities.js";
import {
  FINGERPRINT_WINDOW_DEFAULT_MS,
  FINGERPRINT_WINDOW_MAX_MS,
  __getDeterministicGuardMutexSize,
  reconcileDeterministicDuplicate,
  runDeterministicDuplicateGuard,
} from "../duplicates/duplicate-guard.js";

function mkTask(overrides: Partial<Task> & { id: string; description: string; column: Column }): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    description: overrides.description,
    column: overrides.column,
    dependencies: [],
    createdAt: now,
    updatedAt: now,
    size: "M",
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    source: { sourceType: "api" },
    ...overrides,
  } as Task;
}

function makeStore(seed: Task[] = []): { tasks: Task[]; store: TaskStore } {
  const tasks = [...seed];
  const store = {
    findRecentTasksByContentFingerprint: vi.fn().mockImplementation(async (fp: string, options?: { windowMs?: number; includeArchived?: boolean }) => {
      /*
      FNXC:TaskCreationDeduplication 2026-07-26-07:40:
      Import the real bounds instead of hand-mirroring them. A hardcoded copy here is what let the
      widened window look correct in tests while the production store clamped it back to 5 minutes.
      */
      const windowMs = Math.max(1, Math.min(FINGERPRINT_WINDOW_MAX_MS, Math.trunc(options?.windowMs ?? FINGERPRINT_WINDOW_DEFAULT_MS)));
      const cutoff = Date.now() - windowMs;
      return tasks
        .filter((task) => task.source?.sourceMetadata?.contentFingerprint === fp)
        .filter((task) => (options?.includeArchived ?? false) || task.column !== "archived")
        .filter((task) => Date.parse(task.createdAt) >= cutoff)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    }),
    createTask: vi.fn().mockImplementation(async (input: { title?: string; description: string; source?: Task["source"] }) => {
      const now = new Date().toISOString();
      const created = mkTask({
        id: `FN-${tasks.length + 1}`,
        title: input.title,
        description: input.description,
        column: "todo",
        createdAt: now,
        updatedAt: now,
        source: input.source ?? { sourceType: "api" },
      });
      tasks.push(created);
      return created;
    }),
    updateTask: vi.fn().mockImplementation(async (id: string, updates: { sourceMetadataPatch?: Record<string, unknown> }) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) return null;
      task.source = {
        ...(task.source ?? { sourceType: "api" }),
        sourceMetadata: {
          ...(task.source?.sourceMetadata ?? {}),
          ...(updates.sourceMetadataPatch ?? {}),
        },
      };
      return task;
    }),
    moveTask: vi.fn().mockImplementation(async (id: string, column: Column) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) return null;
      task.column = column;
      return task;
    }),
    deleteTask: vi.fn().mockImplementation(async (id: string) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) return null;
      task.column = "archived";
      task.deletedAt = new Date().toISOString();
      return task;
    }),
    recordActivity: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;

  return { tasks, store };
}

const INPUT = {
  title: "Move retry counter badge next to GitHub tracking badge",
  description: "Move the retry counter badge to the left of the GitHub tracking badge",
};

describe("runDeterministicDuplicateGuard", () => {
  it("returns duplicate when same fingerprint task already exists", async () => {
    const existing = mkTask({
      id: "FN-1",
      title: INPUT.title,
      description: INPUT.description,
      column: "todo",
      source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } },
    });
    const { store } = makeStore([existing]);

    vi.spyOn(store, "findRecentTasksByContentFingerprint").mockResolvedValueOnce([existing]);
    const result = await runDeterministicDuplicateGuard(store, INPUT, { lockScope: "p-1" });
    expect(result.action).toBe("duplicate");
    expect(result.existing?.id).toBe("FN-1");
    result.releaseLock();
  });

  it.each(["done", "archived"] as const)("ignores an exact match in %s", async (column) => {
    const existing = mkTask({
      id: "FN-1",
      title: INPUT.title,
      description: INPUT.description,
      column,
      source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } },
    });
    const { store } = makeStore([existing]);
    vi.spyOn(store, "findRecentTasksByContentFingerprint").mockResolvedValueOnce([existing]);

    const result = await runDeterministicDuplicateGuard(store, INPUT, { lockScope: "p-1" });

    expect(result.action).toBe("proceed");
    result.releaseLock();
  });

  it("ignores an exact match in a renamed complete column", async () => {
    const existing = mkTask({
      id: "FN-1",
      title: INPUT.title,
      description: INPUT.description,
      column: "shipped",
      source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } },
    });
    const { store } = makeStore([existing]);
    vi.spyOn(store, "findRecentTasksByContentFingerprint").mockResolvedValueOnce([existing]);
    const ir = {
      version: "v2", id: "renamed-complete", name: "Renamed complete",
      columns: [
        { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "todo" }],
      edges: [],
    };
    Object.assign(store, {
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "renamed-complete", stepIds: [] })),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "renamed-complete", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async () => ({ ir })),
    });

    const result = await runDeterministicDuplicateGuard(store, INPUT, { lockScope: "p-1" });

    expect(result.action).toBe("proceed");
    result.releaseLock();
  });

  it("scopes exact duplicates to the creating parent task", async () => {
    const foreignSibling = mkTask({
      id: "FN-1",
      title: INPUT.title,
      description: INPUT.description,
      column: "todo",
      sourceParentTaskId: "FN-PARENT-A",
      source: {
        sourceType: "api",
        sourceParentTaskId: "FN-PARENT-A",
        sourceMetadata: { contentFingerprint: "fp" },
      },
    });
    const { store } = makeStore([foreignSibling]);
    vi.spyOn(store, "findRecentTasksByContentFingerprint").mockResolvedValue([foreignSibling]);

    const otherParent = await runDeterministicDuplicateGuard(store, INPUT, {
      lockScope: "p-1",
      sourceParentTaskId: "FN-PARENT-B",
    });
    expect(otherParent.action).toBe("proceed");
    otherParent.releaseLock();

    const sameParent = await runDeterministicDuplicateGuard(store, INPUT, {
      lockScope: "p-1",
      sourceParentTaskId: "FN-PARENT-A",
    });
    expect(sameParent.action).toBe("duplicate");
    expect(sameParent.existing?.id).toBe("FN-1");
    sameParent.releaseLock();
  });

  it("serializes concurrent calls with same lock scope", async () => {
    const { store, tasks } = makeStore();
    const first = runDeterministicDuplicateGuard(store, INPUT, { lockScope: "p-1" });
    const secondPromise = runDeterministicDuplicateGuard(store, INPUT, { lockScope: "p-1" });

    const firstResult = await first;
    expect(firstResult.action).toBe("proceed");

    const created = await store.createTask({
      title: INPUT.title,
      description: INPUT.description,
      source: { sourceType: "api", sourceMetadata: { contentFingerprint: firstResult.fingerprint ?? undefined } },
    });
    expect(tasks).toHaveLength(1);
    firstResult.releaseLock();

    const secondResult = await secondPromise;
    expect(secondResult.action).toBe("duplicate");
    expect(secondResult.existing?.id).toBe(created.id);
    secondResult.releaseLock();
  });

  it("queues three different fingerprints behind one serialization key", async () => {
    const { store } = makeStore();
    const calls = [INPUT, { title: "Second", description: "second description" }, { title: "Third", description: "third description" }];
    const first = await runDeterministicDuplicateGuard(store, calls[0]!, { lockScope: "p-1", serializationKey: "parent:FN-8277" });
    const order: number[] = [];
    const waiting = calls.slice(1).map((input, index) => runDeterministicDuplicateGuard(store, input, {
      lockScope: "p-1", serializationKey: "parent:FN-8277",
    }).then((result) => { order.push(index + 2); return result; }));
    await Promise.resolve();
    expect(order).toEqual([]);
    first.releaseLock();
    const second = await waiting[0]!;
    expect(order).toEqual([2]);
    second.releaseLock();
    const third = await waiting[1]!;
    expect(order).toEqual([2, 3]);
    third.releaseLock();
  });

  it("allows concurrent proceed without shared lock scope", async () => {
    const { store } = makeStore();
    const [a, b] = await Promise.all([
      runDeterministicDuplicateGuard(store, INPUT),
      runDeterministicDuplicateGuard(store, INPUT),
    ]);
    expect(a.action).toBe("proceed");
    expect(b.action).toBe("proceed");
  });

  it("allows proceed when duplicate is acknowledged", async () => {
    const existing = mkTask({ id: "FN-1", title: INPUT.title, description: INPUT.description, column: "todo", source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } } });
    const { store } = makeStore([existing]);
    vi.spyOn(store, "findRecentTasksByContentFingerprint").mockResolvedValueOnce([existing]);
    const result = await runDeterministicDuplicateGuard(store, INPUT, { lockScope: "p-1", acknowledgedDuplicates: ["FN-1"] });
    expect(result.action).toBe("proceed");
    result.releaseLock();
  });

  it("bypass skips mutex allocation", async () => {
    const { store } = makeStore();
    const before = __getDeterministicGuardMutexSize();
    const result = await runDeterministicDuplicateGuard(store, INPUT, { lockScope: "p-1", bypass: true });
    const after = __getDeterministicGuardMutexSize();
    expect(result.action).toBe("proceed");
    expect(after).toBe(before);
  });

  it("ignores rows older than window", async () => {
    const oldTs = new Date(Date.now() - 120_000).toISOString();
    const existing = mkTask({ id: "FN-1", title: INPUT.title, description: INPUT.description, column: "todo", createdAt: oldTs, updatedAt: oldTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } } });
    const { store } = makeStore([existing]);
    vi.spyOn(store, "findRecentTasksByContentFingerprint").mockResolvedValueOnce([]);
    const result = await runDeterministicDuplicateGuard(store, INPUT, { lockScope: "p-1", windowMs: 60_000 });
    expect(result.action).toBe("proceed");
    result.releaseLock();
  });

  /*
  FNXC:TaskCreationDeduplication 2026-07-26-06:45:
  Regression for the ten-duplicate incident: an agent's parallel fn_task_create calls appeared to
  time out, it retried them minutes later, and the retries fell outside the old 60s window. The
  default window must cover a full timeout-and-retry cycle on every entry point — the guard's
  pre-check AND the post-create reconciliation.
  */
  it("catches a retry of the same content minutes after the original committed", async () => {
    const originalTs = new Date(Date.now() - 150_000).toISOString();
    const original = mkTask({ id: "FN-1", title: INPUT.title, description: INPUT.description, column: "todo", createdAt: originalTs, updatedAt: originalTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: computeContentFingerprint(INPUT)! } } });
    const { store } = makeStore([original]);
    const result = await runDeterministicDuplicateGuard(store, INPUT, { lockScope: "p-1" });
    expect(result.action).toBe("duplicate");
    expect(result.existing?.id).toBe("FN-1");
    result.releaseLock();
  });

  it("returns null fingerprint for empty description", async () => {
    const { store } = makeStore();
    const result = await runDeterministicDuplicateGuard(store, { title: "x", description: "..." }, { lockScope: "p-1" });
    expect(result.action).toBe("proceed");
    expect(result.fingerprint).toBeNull();
  });
});

describe("reconcileDeterministicDuplicate", () => {
  it("does not archive new work against a completed sibling", async () => {
    const canonicalTs = new Date(Date.now() - 2_000).toISOString();
    const createdTs = new Date().toISOString();
    const completed = mkTask({ id: "FN-1", title: INPUT.title, description: INPUT.description, column: "done", createdAt: canonicalTs, updatedAt: canonicalTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } } });
    const created = mkTask({ id: "FN-2", title: INPUT.title, description: INPUT.description, column: "todo", createdAt: createdTs, updatedAt: createdTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } } });
    const { store } = makeStore([completed, created]);
    vi.spyOn(store, "findRecentTasksByContentFingerprint").mockResolvedValueOnce([completed, created]);

    const result = await reconcileDeterministicDuplicate(store, { createdTask: created, fingerprint: "fp" });

    expect(result).toEqual({ outcome: "kept", canonical: created });
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("does not archive an identical task created by a different parent", async () => {
    const canonicalTs = new Date(Date.now() - 2_000).toISOString();
    const createdTs = new Date().toISOString();
    const foreignSibling = mkTask({
      id: "FN-1",
      title: INPUT.title,
      description: INPUT.description,
      column: "todo",
      createdAt: canonicalTs,
      updatedAt: canonicalTs,
      sourceParentTaskId: "FN-PARENT-A",
      source: { sourceType: "api", sourceParentTaskId: "FN-PARENT-A", sourceMetadata: { contentFingerprint: "fp" } },
    });
    const created = mkTask({
      id: "FN-2",
      title: INPUT.title,
      description: INPUT.description,
      column: "todo",
      createdAt: createdTs,
      updatedAt: createdTs,
      sourceParentTaskId: "FN-PARENT-B",
      source: { sourceType: "api", sourceParentTaskId: "FN-PARENT-B", sourceMetadata: { contentFingerprint: "fp" } },
    });
    const { store } = makeStore([foreignSibling, created]);
    vi.spyOn(store, "findRecentTasksByContentFingerprint").mockResolvedValueOnce([foreignSibling, created]);

    const result = await reconcileDeterministicDuplicate(store, {
      createdTask: created,
      fingerprint: "fp",
      sourceParentTaskId: "FN-PARENT-B",
    });

    expect(result).toEqual({ outcome: "kept", canonical: created });
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("soft-deletes a late-race loser without emitting retired archive events", async () => {
    const canonicalTs = new Date(Date.now() - 2_000).toISOString();
    const createdTs = new Date().toISOString();
    const canonical = mkTask({ id: "FN-1", title: INPUT.title, description: INPUT.description, column: "todo", createdAt: canonicalTs, updatedAt: canonicalTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } } });
    const created = mkTask({ id: "FN-2", title: INPUT.title, description: INPUT.description, column: "todo", createdAt: createdTs, updatedAt: createdTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } } });
    const { store } = makeStore([canonical, created]);
    vi.spyOn(store, "findRecentTasksByContentFingerprint").mockResolvedValueOnce([canonical, created]);

    const result = await reconcileDeterministicDuplicate(store, { createdTask: created, fingerprint: "fp" });
    expect(result).toEqual({ outcome: "removed", canonical });
    expect(store.updateTask).toHaveBeenCalledWith("FN-2", {
      sourceMetadataPatch: {
        contentFingerprint: "fp",
        deterministicDuplicateOf: "FN-1",
      },
    });
    expect(store.deleteTask).toHaveBeenCalledWith("FN-2", { allowResurrection: false });
    expect(store.recordActivity).not.toHaveBeenCalled();
  });
  it("fails open when soft-delete throws", async () => {
    const canonicalTs = new Date(Date.now() - 2_000).toISOString();
    const createdTs = new Date().toISOString();
    const canonical = mkTask({ id: "FN-1", title: INPUT.title, description: INPUT.description, column: "todo", createdAt: canonicalTs, updatedAt: canonicalTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } } });
    const created = mkTask({ id: "FN-2", title: INPUT.title, description: INPUT.description, column: "todo", createdAt: createdTs, updatedAt: createdTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } } });
    const { store } = makeStore([canonical, created]);
    vi.spyOn(store, "findRecentTasksByContentFingerprint").mockResolvedValueOnce([canonical, created]);
    vi.spyOn(store, "deleteTask").mockRejectedValueOnce(new Error("delete failed"));

    const warn = vi.fn();
    const result = await reconcileDeterministicDuplicate(store, { createdTask: created, fingerprint: "fp", logger: { warn } });
    expect(result).toEqual({ outcome: "kept", canonical: created });
    expect(warn).toHaveBeenCalled();
  });
});

/*
FNXC:TaskCreationDeduplication 2026-07-26-07:40:
The store query owns a SECOND clamp on the same window. Code review found that widening only
duplicate-guard.ts capped the effective window at the store's own 5-minute ceiling, and no test
caught it because the guard tests stub the query. The second clamp now lives in ONE exported policy
function that both the guard and the store query call, so the two cannot drift apart again — and it is
asserted directly rather than recovered from a stubbed query's cutoff string.
*/
describe("duplicate-guard fingerprint window policy", () => {

  /*
  FNXC:TaskCreationDeduplication 2026-07-30-04:20:
  Asserted on the pure policy function instead of through a store fake. These three drove
  `findRecentTasksByContentFingerprintImpl` against a fake modelling the DELETED SQLite path
  (`db.prepare().all()`) and recovered the window by parsing a captured cutoff string; that fake broke
  when the query moved to `asyncLayer` + Drizzle ("Cannot read properties of undefined (reading
  'projectId')").

  Rebuilding a Drizzle chain to recover a number the policy already returns would be mock-the-world
  for no gain. Targeting `resolveFingerprintWindowMs` also removes the +/-5s timing tolerance the old
  shape needed, so these now assert exact values.
  */
  it("defaults to the shared 10-minute window, not the store's old 60s/5m pair", () => {
    expect(resolveFingerprintWindowMs()).toBe(FINGERPRINT_WINDOW_DEFAULT_MS);
    expect(FINGERPRINT_WINDOW_DEFAULT_MS).toBeGreaterThan(300_000);
  });

  it("honors an explicit window above the old 5-minute ceiling", () => {
    expect(resolveFingerprintWindowMs(20 * 60_000)).toBe(20 * 60_000);
    expect(resolveFingerprintWindowMs(20 * 60_000)).toBeGreaterThan(300_000);
  });

  it("still clamps to the shared ceiling", () => {
    expect(resolveFingerprintWindowMs(24 * 60 * 60_000)).toBe(FINGERPRINT_WINDOW_MAX_MS);
  });

  /*
  FNXC:TaskCreationDeduplication 2026-07-30-05:40 (coderabbit, major):
  Regression for a PRE-EXISTING crash the extraction exposed: `Math.trunc(NaN)` is NaN and both clamps
  pass it through, so the caller's `new Date(Date.now() - windowMs).toISOString()` threw "Invalid time
  value". Verified by running the old inline expression directly.
  */
  it("falls back to the default for a non-finite request instead of propagating NaN", () => {
    expect(resolveFingerprintWindowMs(Number.NaN)).toBe(FINGERPRINT_WINDOW_DEFAULT_MS);
    expect(resolveFingerprintWindowMs(Number.POSITIVE_INFINITY)).toBe(FINGERPRINT_WINDOW_DEFAULT_MS);
    // The point of the guard: the value must be usable as a Date offset.
    expect(() => new Date(Date.now() - resolveFingerprintWindowMs(Number.NaN)).toISOString()).not.toThrow();
  });

  it("floors at 1ms so a zero or negative request cannot produce a future cutoff", () => {
    // The `Math.max(1, ...)` half of the policy, which the old cutoff-parsing shape could not see.
    expect(resolveFingerprintWindowMs(0)).toBe(1);
    expect(resolveFingerprintWindowMs(-5_000)).toBe(1);
  });
});
