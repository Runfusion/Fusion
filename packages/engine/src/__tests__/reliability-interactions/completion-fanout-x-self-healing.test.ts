import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  exec: vi.fn((_: string, optsOrCb: unknown, cbMaybe?: (err: unknown, stdout: string, stderr: string) => void) => {
    const cb = typeof optsOrCb === "function" ? optsOrCb : cbMaybe;
    cb?.(null, "", "");
  }),
  execSync: vi.fn(),
  execFile: vi.fn((_file: string, _args: unknown, optsOrCb: unknown, cbMaybe?: (err: unknown, stdout: string, stderr: string) => void) => {
    const cb = typeof optsOrCb === "function" ? optsOrCb : cbMaybe;
    cb?.(null, "", "");
  }),
}));
import { EventEmitter } from "node:events";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function storeWith(tasks: Task[]): TaskStore & EventEmitter {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async (opts?: { column?: Task["column"]; includeArchived?: boolean }) => {
      const all = [...map.values()];
      if (!opts?.column) return all;
      return all.filter((t) => t.column === opts.column);
    }),
    getTask: vi.fn(async (id: string) => map.get(id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      map.set(id, { ...map.get(id)!, ...patch } as Task);
      return map.get(id);
    }),
    logEntry: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
}

describe("reliability interaction: completion fan-out x stale blockedBy sweep", () => {
  it("does not double-clear same dependent", async () => {
    const blocker = task("FN-B", { column: "done" });
    const dependent = task("FN-D", { column: "todo", blockedBy: "FN-B" });
    const store = storeWith([blocker, dependent]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await manager.reconcileCompletedTask("FN-B");
    const firstCalls = (store as any).updateTask.mock.calls.length;
    await manager.clearStaleBlockedBy();
    const secondCalls = (store as any).updateTask.mock.calls.length;

    expect((await store.getTask("FN-D"))?.blockedBy).toBeNull();
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });
});
