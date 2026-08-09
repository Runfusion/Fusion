import {describe, expect, it, vi} from "vitest";
import type {Task} from "../types.js";
import type {TaskStore} from "../store.js";
import {updateTaskUnlockedImpl} from "../task-store/task-update.js";

/*
FNXC:NodeRouting 2026-08-09-05:08:
Revert proof for #3365: removing the invalidation branch breaks the exact repro and clear assertions;
moving checkout capture to the field-write site breaks e2 after reassignment clears checkedOutBy; replacing
per-field decisions with one supplied flag breaks f2/f3 by retaining the stale companion snapshot field.
*/
function harness(task: Partial<Task>) {
  const row = {
    id: "FN-1", column: "todo", dependencies: [], steps: [], log: [], status: null,
    title: "t", description: "d", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    ...task,
  } as unknown as Task;
  const store = {
    taskDir: () => "/tmp/does-not-matter",
    readTaskJson: async () => row,
    writeTaskJson: vi.fn(async () => undefined),
    atomicWriteTaskJson: vi.fn(async () => undefined),
    syncAgentTaskLinkOnReassignment: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    getSettings: vi.fn(async () => ({})),
    assertNoDependencyCycle: vi.fn(async () => undefined),
    getTaskWorkflowSelection: () => undefined,
    getTaskWorkflowSelectionAsync: async () => undefined,
    emit: vi.fn(),
    isWatching: false,
    taskCache: new Map(),
    laneCache: {set: vi.fn(), get: vi.fn(), invalidate: vi.fn()},
  } as Record<string, unknown>;
  const proxied = new Proxy(store, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as unknown as TaskStore;
  return {store: proxied, row};
}

const run = (store: TaskStore, updates: Record<string, unknown>) =>
  updateTaskUnlockedImpl(store, "FN-1", updates as never).catch((error: unknown) => {
    if (error instanceof Error && /ENOENT|EACCES|no such file/i.test(error.message)) return null;
    throw error;
  });

const staleRoute = {
  column: "todo",
  nodeId: "node-old",
  effectiveNodeId: "node-old",
  effectiveNodeSource: "task-override" as const,
};

const hasInvalidationLog = (row: Task) => row.log?.some((entry) =>
  entry.action.includes("Effective route invalidated after node override change"),
) ?? false;

describe("updateTaskUnlockedImpl effective route invalidation", () => {
  it("a: clears the issue's stale dispatch snapshot when nodeId changes", async () => {
    const {store, row} = harness(staleRoute);
    await run(store, {nodeId: "node-new"});
    expect(row.nodeId).toBe("node-new");
    expect(row.effectiveNodeId).toBeUndefined();
    expect(row.effectiveNodeSource).toBeUndefined();
    expect(hasInvalidationLog(row)).toBe(true);
  });

  it("b: invalidates after a null node override clear", async () => {
    const {store, row} = harness(staleRoute);
    await run(store, {nodeId: null});
    expect(row.nodeId).toBeUndefined();
    expect(row.effectiveNodeId).toBeUndefined();
    expect(row.effectiveNodeSource).toBeUndefined();
  });

  it("c/d/d2: preserves routes without an actual override change", async () => {
    const same = harness(staleRoute);
    await run(same.store, {nodeId: "node-old"});
    expect(same.row.effectiveNodeId).toBe("node-old");
    expect(hasInvalidationLog(same.row)).toBe(false);

    const omitted = harness(staleRoute);
    await run(omitted.store, {});
    expect(omitted.row.effectiveNodeId).toBe("node-old");

    const partialWithoutOverride = harness(staleRoute);
    await run(partialWithoutOverride.store, {effectiveNodeSource: "local"});
    expect(partialWithoutOverride.row.effectiveNodeId).toBe("node-old");
    expect(partialWithoutOverride.row.effectiveNodeSource).toBe("local");
  });

  it("e/e2/e3/e4: preserves routes held by checkout ownership", async () => {
    const checkedOut = harness({...staleRoute, checkedOutBy: "agent-x"});
    await run(checkedOut.store, {nodeId: "node-new"});
    expect(checkedOut.row.effectiveNodeId).toBe("node-old");

    const reassigned = harness({...staleRoute, assignedAgentId: "agent-x", checkedOutBy: "agent-x"});
    await run(reassigned.store, {assignedAgentId: "agent-y", nodeId: "node-new"});
    expect(reassigned.row.checkedOutBy).toBeUndefined();
    expect(reassigned.row.effectiveNodeId).toBe("node-old");
    expect(reassigned.row.effectiveNodeSource).toBe("task-override");
    expect(hasInvalidationLog(reassigned.row)).toBe(false);

    const checkoutStarted = harness(staleRoute);
    await run(checkoutStarted.store, {checkedOutBy: "agent-x", nodeId: "node-new"});
    expect(checkoutStarted.row.effectiveNodeId).toBe("node-old");

    const released = harness({...staleRoute, checkedOutBy: "agent-x"});
    await run(released.store, {checkedOutBy: null, nodeId: "node-new"});
    expect(released.row.effectiveNodeId).toBe("node-old");
  });

  it("f/f2/f3/f4: honors replacements per field without retaining stale companions", async () => {
    const complete = harness(staleRoute);
    await run(complete.store, {
      nodeId: "node-new", effectiveNodeId: "node-new", effectiveNodeSource: "task-override",
    });
    expect(complete.row.effectiveNodeId).toBe("node-new");
    expect(complete.row.effectiveNodeSource).toBe("task-override");
    expect(hasInvalidationLog(complete.row)).toBe(false);

    const sourceOnly = harness(staleRoute);
    await run(sourceOnly.store, {nodeId: "node-new", effectiveNodeSource: "local"});
    expect(sourceOnly.row.effectiveNodeId).toBeUndefined();
    expect(sourceOnly.row.effectiveNodeSource).toBe("local");

    const idOnly = harness(staleRoute);
    await run(idOnly.store, {nodeId: "node-new", effectiveNodeId: "node-new"});
    expect(idOnly.row.effectiveNodeId).toBe("node-new");
    expect(idOnly.row.effectiveNodeSource).toBeUndefined();

    const explicitClear = harness(staleRoute);
    await run(explicitClear.store, {nodeId: "node-new", effectiveNodeId: null});
    expect(explicitClear.row.effectiveNodeId).toBeUndefined();
    expect(explicitClear.row.effectiveNodeSource).toBeUndefined();
  });

  it("g: invalidates every dispatch source identically", async () => {
    for (const effectiveNodeSource of ["project-default", "local"] as const) {
      const {store, row} = harness({...staleRoute, effectiveNodeSource});
      await run(store, {nodeId: "node-new"});
      expect(row.effectiveNodeId).toBeUndefined();
      expect(row.effectiveNodeSource).toBeUndefined();
    }
  });
});
