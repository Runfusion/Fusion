import { describe, expect, it } from "vitest";
import { TaskStore } from "../store.js";
import type { Task } from "../types.js";

const task = { id: "FN-observed", title: "Observed", column: "done" } as Task;

describe("observed task:deleted dispatch", () => {
  it("evicts local cache, preserves delete intent, and marks notifications observed", () => {
    const store = new TaskStore(process.cwd());
    store.taskCache.set(task.id, task);
    const received: Array<{
      observed?: boolean;
      outboxEventId?: string;
      githubIssueAction?: "leave";
      closureContext?: { kind: "split-into-subtasks"; childTaskIds: string[] };
    } | undefined> = [];
    store.on("task:deleted", () => { throw new Error("listener failure must not stop fan-out"); });
    store.on("task:deleted", (_task, meta) => received.push(meta));

    expect(store.emitObservedTaskDeleted(task, "evt_observed", {
      githubIssueAction: "leave",
      closureContext: { kind: "split-into-subtasks", childTaskIds: ["FN-child"] },
    })).toBe(true);
    expect(store.taskCache.has(task.id)).toBe(false);
    expect(received).toEqual([{
      observed: true,
      outboxEventId: "evt_observed",
      githubIssueAction: "leave",
      closureContext: { kind: "split-into-subtasks", childTaskIds: ["FN-child"] },
    }]);

    // The specified crash-window duplicate remains a harmless cache eviction + bridge notification.
    expect(store.emitObservedTaskDeleted(task, "evt_observed")).toBe(true);
    expect(received).toHaveLength(2);
  });
});
