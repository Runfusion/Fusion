import { describe, expect, it } from "vitest";
import { TaskStore } from "../store.js";
import type { Task } from "../types.js";

const task = { id: "FN-lanes", column: "building" } as Task;

describe("task lifecycle lane payload", () => {
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

  /*
  FNXC:PlanningModeScheduling 2026-08-03-09:44:
  A created task needs the workflow lanes captured at the durable creation boundary; triage cannot
  synchronously resolve a custom selection after its wake handler receives the event.
  */
  it("delivers resolved lanes with task:created without changing one-argument listeners", () => {
    const store = new TaskStore(process.cwd());
    const received: Array<{ lanes?: { intake?: string; hold?: string } } | undefined> = [];
    let oneArgumentCalls = 0;
    store.on("task:created", (_task, meta) => received.push(meta));
    store.on("task:created", () => { oneArgumentCalls += 1; });

    store.emitTaskLifecycleEventSafely("task:created", [task, { lanes: { intake: "planning-inbox", hold: "ready-to-plan" } }]);

    expect(received).toEqual([{ lanes: { intake: "planning-inbox", hold: "ready-to-plan" } }]);
    expect(oneArgumentCalls).toBe(1);
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
