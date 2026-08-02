import { describe, expect, it } from "vitest";
import { TaskStore } from "../store.js";
import type { Task } from "../types.js";

const task = { id: "FN-lanes", column: "building" } as Task;

describe("task:updated lane payload", () => {
  it("decorates cache hits while keeping one-argument listeners and misses compatible", () => {
    const store = new TaskStore(process.cwd());
    const received: Array<{ lanes?: { wip?: string } } | undefined> = [];
    let oneArgumentCalls = 0;
    store.on("task:updated", (_task, meta) => received.push(meta));
    store.on("task:updated", () => { oneArgumentCalls += 1; });

    store.laneCache.set(task.id, { wip: "building" });
    store.emit("task:updated", task);
    store.laneCache.invalidate(task.id);
    store.emit("task:updated", task);

    expect(received).toEqual([{ lanes: { wip: "building" } }, undefined]);
    expect(oneArgumentCalls).toBe(2);
  });

  it("decorates safe lifecycle emissions, which invoke listeners without EventEmitter.emit", () => {
    const store = new TaskStore(process.cwd());
    store.laneCache.set(task.id, { wip: "building" });
    let received: { lanes?: { wip?: string } } | undefined;
    store.on("task:updated", (_task, meta) => { received = meta; });

    store.emitTaskLifecycleEventSafely("task:updated", [task]);
    expect(received).toEqual({ lanes: { wip: "building" } });
  });

  it("preserves explicit metadata rather than replacing it from cache", () => {
    const store = new TaskStore(process.cwd());
    store.laneCache.set(task.id, { wip: "cached" });
    let received: { lanes?: { wip?: string } } | undefined;
    store.on("task:updated", (_task, meta) => { received = meta; });
    store.emit("task:updated", task, { lanes: { wip: "explicit" } });
    expect(received).toEqual({ lanes: { wip: "explicit" } });
  });
});
