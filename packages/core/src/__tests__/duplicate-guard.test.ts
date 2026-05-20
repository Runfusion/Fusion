import { describe, expect, it, vi } from "vitest";

import type { Column, Task } from "../types.js";
import type { TaskStore } from "../store.js";
import {
  __getDeterministicGuardMutexSize,
  reconcileDeterministicDuplicate,
  runDeterministicDuplicateGuard,
} from "../duplicate-guard.js";

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
      const windowMs = Math.max(1, Math.min(300_000, Math.trunc(options?.windowMs ?? 60_000)));
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

  it("returns null fingerprint for empty description", async () => {
    const { store } = makeStore();
    const result = await runDeterministicDuplicateGuard(store, { title: "x", description: "..." }, { lockScope: "p-1" });
    expect(result.action).toBe("proceed");
    expect(result.fingerprint).toBeNull();
  });
});

describe("reconcileDeterministicDuplicate", () => {
  it("archives late-race loser and records activity metadata", async () => {
    const canonicalTs = new Date(Date.now() - 2_000).toISOString();
    const createdTs = new Date().toISOString();
    const canonical = mkTask({ id: "FN-1", title: INPUT.title, description: INPUT.description, column: "todo", createdAt: canonicalTs, updatedAt: canonicalTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } } });
    const created = mkTask({ id: "FN-2", title: INPUT.title, description: INPUT.description, column: "todo", createdAt: createdTs, updatedAt: createdTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } } });
    const { store } = makeStore([canonical, created]);
    vi.spyOn(store, "findRecentTasksByContentFingerprint").mockResolvedValueOnce([canonical, created]);

    const result = await reconcileDeterministicDuplicate(store, { createdTask: created, fingerprint: "fp" });
    expect(result).toEqual({ outcome: "archived", canonical });
    expect(store.updateTask).toHaveBeenCalledWith("FN-2", {
      sourceMetadataPatch: {
        contentFingerprint: "fp",
        deterministicDuplicateOf: "FN-1",
      },
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-2", "archived");
    expect(store.recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:auto-archived-deterministic-duplicate",
      metadata: { canonicalTaskId: "FN-1", contentFingerprint: "fp" },
    }));
  });

  it("fails open when archive move throws", async () => {
    const canonicalTs = new Date(Date.now() - 2_000).toISOString();
    const createdTs = new Date().toISOString();
    const canonical = mkTask({ id: "FN-1", title: INPUT.title, description: INPUT.description, column: "todo", createdAt: canonicalTs, updatedAt: canonicalTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } } });
    const created = mkTask({ id: "FN-2", title: INPUT.title, description: INPUT.description, column: "todo", createdAt: createdTs, updatedAt: createdTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: "fp" } } });
    const { store } = makeStore([canonical, created]);
    vi.spyOn(store, "findRecentTasksByContentFingerprint").mockResolvedValueOnce([canonical, created]);
    vi.spyOn(store, "moveTask").mockRejectedValueOnce(new Error("archive failed"));

    const warn = vi.fn();
    const result = await reconcileDeterministicDuplicate(store, { createdTask: created, fingerprint: "fp", logger: { warn } });
    expect(result).toEqual({ outcome: "kept", canonical: created });
    expect(warn).toHaveBeenCalled();
  });
});
