import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { AutoClaimSnapshotManager, extractDescriptionFirstLine, isRunnableAutoClaimCandidate, resolveFreshAutoClaimCandidates } from "../scheduling/auto-claim-snapshot.js";

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? null,
    description: overrides.description ?? "desc",
    status: overrides.status ?? "open",
    column: overrides.column ?? "todo",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    dependencies: overrides.dependencies ?? [],
    comments: overrides.comments ?? [],
    steps: overrides.steps ?? [],
    currentStep: overrides.currentStep ?? 0,
    log: overrides.log ?? [],
    assignedAgentId: overrides.assignedAgentId,
    checkedOutBy: overrides.checkedOutBy,
    paused: overrides.paused,
    deletedAt: overrides.deletedAt,
    columnMovedAt: overrides.columnMovedAt,
  } as unknown as Task;
}

describe("AutoClaimSnapshotManager", () => {
  it("uses the shared predicate for unchanged runnability filter cases", () => {
    const firstRunnable = makeTask({ id: "FN-1", dependencies: ["FN-done", "FN-archived"] });
    const secondRunnable = makeTask({ id: "FN-2" });
    const tasks = [
      firstRunnable,
      makeTask({ id: "FN-paused", paused: true }),
      makeTask({ id: "FN-assigned", assignedAgentId: "agent-1" }),
      makeTask({ id: "FN-checked", checkedOutBy: "agent-2" }),
      makeTask({ id: "FN-deleted", deletedAt: "2026-01-02T00:00:00.000Z" } as Partial<Task> & Pick<Task, "id">),
      makeTask({ id: "FN-blocked", dependencies: ["FN-open"] }),
      makeTask({ id: "FN-triage", column: "triage" }),
      makeTask({ id: "FN-done", column: "done" }),
      makeTask({ id: "FN-archived", column: "archived" }),
      makeTask({ id: "FN-open", column: "in-progress" }),
      makeTask({ id: "FN-review", column: "in-review" }),
      secondRunnable,
    ];
    const tasksById = new Map(tasks.map((task) => [task.id, task]));

    expect(tasks.filter((task) => isRunnableAutoClaimCandidate(task, tasksById)).map((task) => task.id)).toEqual(["FN-1", "FN-2"]);
  });

  it("shares one listTasks call across concurrent getSnapshot calls", async () => {
    const listTasks = vi.fn(async () => [makeTask({ id: "FN-1" })]);
    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks }, now: () => Date.parse("2026-01-03T00:00:00.000Z") });

    await Promise.all([manager.getSnapshot(), manager.getSnapshot(), manager.getSnapshot()]);

    expect(listTasks).toHaveBeenCalledTimes(1);
  });

  it("rebuilds after TTL expiry", async () => {
    let now = Date.parse("2026-01-03T00:00:00.000Z");
    const listTasks = vi.fn(async () => [makeTask({ id: "FN-1" })]);
    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks }, ttlMs: 10, now: () => now });

    await manager.getSnapshot();
    now += 20;
    await manager.getSnapshot();

    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it("rebuilds after explicit invalidation", async () => {
    const listTasks = vi.fn(async () => [makeTask({ id: "FN-1" })]);
    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks } });

    await manager.getSnapshot();
    manager.invalidate("test");
    await manager.getSnapshot();

    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it("filters paused/assigned/checked-out/blocked tasks", async () => {
    const tasks = [
      makeTask({ id: "FN-1", dependencies: ["FN-done"] }),
      makeTask({ id: "FN-paused", paused: true }),
      makeTask({ id: "FN-assigned", assignedAgentId: "agent-1" }),
      makeTask({ id: "FN-checked", checkedOutBy: "agent-2" }),
      makeTask({ id: "FN-blocked", dependencies: ["FN-open"] }),
      makeTask({ id: "FN-done", column: "done" }),
      makeTask({ id: "FN-open", column: "in-progress" }),
    ];
    const listTasks = vi.fn(async () => tasks);
    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks } });

    const snapshot = await manager.getSnapshot();

    expect(snapshot.tasks.map((t) => t.id)).toEqual(["FN-1"]);
  });

  it("re-resolves cached candidates against canonical runnable rows", async () => {
    const initialTasks = [
      makeTask({ id: "FN-stale-triage", title: "Old title", description: "old desc", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({ id: "FN-retitled", title: "Old runnable title", description: "old runnable desc", createdAt: "2026-01-02T00:00:00.000Z" }),
      makeTask({ id: "FN-paused", createdAt: "2026-01-03T00:00:00.000Z" }),
      makeTask({ id: "FN-assigned", createdAt: "2026-01-04T00:00:00.000Z" }),
      makeTask({ id: "FN-checked", createdAt: "2026-01-05T00:00:00.000Z" }),
      makeTask({ id: "FN-deleted", createdAt: "2026-01-06T00:00:00.000Z" }),
      makeTask({ id: "FN-blocked", dependencies: ["FN-dep"], createdAt: "2026-01-07T00:00:00.000Z" }),
      makeTask({ id: "FN-missing", createdAt: "2026-01-08T00:00:00.000Z" }),
      makeTask({ id: "FN-dep", column: "done" }),
      makeTask({ id: "FN-survivor", title: "Survivor", createdAt: "2026-01-09T00:00:00.000Z" }),
    ];
    const canonicalTasks = [
      makeTask({ id: "FN-stale-triage", title: "Superseded stale title", column: "triage" }),
      makeTask({ id: "FN-retitled", title: "Updated runnable title", description: "updated first line\nsecond", createdAt: "2026-01-02T00:00:00.000Z" }),
      makeTask({ id: "FN-paused", paused: true }),
      makeTask({ id: "FN-assigned", assignedAgentId: "agent-1" }),
      makeTask({ id: "FN-checked", checkedOutBy: "agent-2" }),
      makeTask({ id: "FN-deleted", deletedAt: "2026-01-10T00:00:00.000Z" } as Partial<Task> & Pick<Task, "id">),
      makeTask({ id: "FN-blocked", dependencies: ["FN-dep"] }),
      makeTask({ id: "FN-dep", column: "in-progress" }),
      makeTask({ id: "FN-survivor", title: "Survivor", createdAt: "2026-01-09T00:00:00.000Z" }),
    ];
    const listTasks = vi.fn()
      .mockResolvedValueOnce(initialTasks)
      .mockResolvedValueOnce(canonicalTasks);
    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks }, now: () => Date.parse("2026-01-12T00:00:00.000Z") });

    const snapshot = await manager.getSnapshot();
    const resolved = await resolveFreshAutoClaimCandidates({ listTasks }, snapshot.tasks, () => Date.parse("2026-01-12T00:00:00.000Z"));

    expect(listTasks).toHaveBeenCalledTimes(2);
    expect(resolved.map((candidate) => candidate.id)).toEqual(["FN-retitled", "FN-survivor"]);
    expect(resolved[0]).toMatchObject({
      id: "FN-retitled",
      title: "Updated runnable title",
      description: "updated first line\nsecond",
      descriptionFirstLine: "updated first line",
      column: "todo",
    });
  });

  it("drops archived-while-cached candidates but keeps runnable siblings with canonical fields", async () => {
    const initialTasks = [
      makeTask({ id: "FN-6872", title: "Re-ratchet line-count baseline", description: "archived later", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({ id: "FN-TODO", title: "Old sibling title", description: "old sibling desc", createdAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const canonicalTasks = [
      makeTask({ id: "FN-6872", title: "Re-ratchet line-count baseline", description: "now archived", column: "archived", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({ id: "FN-TODO", title: "Canonical sibling title", description: "canonical first line\nsecond", createdAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const listTasks = vi.fn()
      .mockResolvedValueOnce(initialTasks)
      .mockResolvedValueOnce(canonicalTasks);
    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks }, now: () => Date.parse("2026-01-12T00:00:00.000Z") });

    const snapshot = await manager.getSnapshot();
    expect(snapshot.tasks.map((candidate) => candidate.id)).toEqual(["FN-6872", "FN-TODO"]);

    const resolved = await resolveFreshAutoClaimCandidates({ listTasks }, snapshot.tasks, () => Date.parse("2026-01-12T00:00:00.000Z"));

    expect(resolved.map((candidate) => candidate.id)).toEqual(["FN-TODO"]);
    expect(resolved[0]).toMatchObject({
      title: "Canonical sibling title",
      description: "canonical first line\nsecond",
      descriptionFirstLine: "canonical first line",
      column: "todo",
    });
  });

  it("treats archived dependencies as satisfied without making archived tasks candidates", async () => {
    const dependent = makeTask({ id: "FN-dependent", dependencies: ["FN-archived-dependency"] });
    const archivedDependency = makeTask({ id: "FN-archived-dependency", column: "archived" });
    const tasks = [dependent, archivedDependency];
    const tasksById = new Map(tasks.map((task) => [task.id, task]));

    expect(isRunnableAutoClaimCandidate(dependent, tasksById)).toBe(true);
    expect(isRunnableAutoClaimCandidate(archivedDependency, tasksById)).toBe(false);

    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks: vi.fn(async () => tasks) } });
    const snapshot = await manager.getSnapshot();

    expect(snapshot.tasks.map((candidate) => candidate.id)).toEqual(["FN-dependent"]);
  });

  it("sorts by columnMovedAt then createdAt ascending", async () => {
    const tasks = [
      makeTask({ id: "FN-3", createdAt: "2026-01-03T00:00:00.000Z" }),
      makeTask({ id: "FN-1", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({ id: "FN-2", createdAt: "2026-01-02T00:00:00.000Z", columnMovedAt: "2026-01-01T12:00:00.000Z" }),
    ];
    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks: vi.fn(async () => tasks) } });

    const snapshot = await manager.getSnapshot();

    expect(snapshot.tasks.map((t) => t.id)).toEqual(["FN-1", "FN-2", "FN-3"]);
  });

  it("caps candidate set to 50 and computes capped baseScore", async () => {
    const tasks = Array.from({ length: 55 }, (_, idx) => makeTask({
      id: `FN-${idx + 1}`,
      createdAt: "2025-12-01T00:00:00.000Z",
    }));
    const manager = new AutoClaimSnapshotManager({
      taskStore: { listTasks: vi.fn(async () => tasks) },
      now: () => Date.parse("2026-01-03T00:00:00.000Z"),
    });

    const snapshot = await manager.getSnapshot();

    expect(snapshot.tasks).toHaveLength(50);
    expect(snapshot.tasks[0]?.baseScore).toBe(5);
  });

  it("extracts first non-empty description line and caps length", () => {
    expect(extractDescriptionFirstLine("\n\nfirst line\nsecond line")).toBe("first line");
    expect(extractDescriptionFirstLine("   \n\t\n")).toBe("");
    expect(extractDescriptionFirstLine("x".repeat(400))).toHaveLength(160);
  });
});
