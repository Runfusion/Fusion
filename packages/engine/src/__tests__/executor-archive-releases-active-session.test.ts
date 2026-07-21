/*
FNXC:WorkflowLifecycle 2026-07-09-00:00 (FN-7717 regression):
Archiving a task must release every activeSessionRegistry entry it holds. Plan Review and
other workflow-step / step-session sessions run while a task is in triage/planning/todo (not
in-progress), so the executor's task:moved handler previously only disposed session surfaces
via the `from === "in-progress"` branch — a task archived from any OTHER column leaked its
registry entry and blocked a successor task from registering the same session path with
ActiveSessionPathHeldByForeignTaskError (NEXT-508 -> NEXT-433). This suite proves the fix
across all three registration surfaces (executor / step-session / workflow-step), the
leaked-entry sweep path (no in-memory session) including when archiving DIRECTLY from
in-progress in a single task:moved hop (a branch-ordering gap the fix also closes), the
done/in-review merge-lease exclusion, and the no-op case (task with no held paths).
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { TaskStore } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { activeSessionRegistry, ActiveSessionPathHeldByForeignTaskError } from "../active-session-registry.js";

const SHARED_ROOT = "/tmp/fusion-test-archive-shared-root";

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRunContextFor: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
  }) as unknown as TaskStore & EventEmitter;
}

function makeExecutor(): { executor: TaskExecutor; store: TaskStore & EventEmitter } {
  const store = createStore();
  const executor = new TaskExecutor(store, SHARED_ROOT);
  return { executor, store };
}

function makeTask(id: string): any {
  return { id, column: "archived" };
}

describe("archiving a task releases its active-session registry entries (FN-7717)", () => {
  beforeEach(() => activeSessionRegistry.clear());
  afterEach(() => activeSessionRegistry.clear());

  it("releases a workflow-step session held by a task archived from triage, letting a successor acquire the same path", async () => {
    const { executor, store } = makeExecutor();

    // Task A registers a workflow-step (Plan Review) session on the shared root — the
    // reported NEXT-508 case.
    (executor as any).setActiveWorkflowStepSession("TASK-A", {}, SHARED_ROOT);
    expect(activeSessionRegistry.isPathActive(SHARED_ROOT)).toBe(true);

    // Drive the archive transition: to === "archived", from a NON-in-progress column
    // (Plan Review runs in triage), exactly like archiveTask emits.
    store.emit("task:moved", { task: makeTask("TASK-A"), from: "triage", to: "archived", source: "user" });

    // Await the disposal chain the handler kicked off via trackTaskDisposal.
    await (executor as any).pendingTaskDisposals.get("TASK-A");

    expect(activeSessionRegistry.isPathActive(SHARED_ROOT)).toBe(false);
    expect(activeSessionRegistry.pathsForTask("TASK-A")).toHaveLength(0);

    // Successor task B can now register the same path without throwing.
    expect(() =>
      activeSessionRegistry.registerPath(SHARED_ROOT, { taskId: "TASK-B", kind: "workflow-step", ownerKey: "TASK-B#workflow-step" }),
    ).not.toThrow();
  });

  it("releases executor and step-session surfaces archived from planning/todo columns", async () => {
    const { executor, store } = makeExecutor();

    (executor as any).setActiveSession("TASK-C", { session: { dispose: vi.fn() } }, `${SHARED_ROOT}-c`);
    (executor as any).setActiveStepExecutor("TASK-D", { terminateAllSessions: vi.fn().mockResolvedValue(undefined) }, `${SHARED_ROOT}-d`);

    store.emit("task:moved", { task: makeTask("TASK-C"), from: "planning", to: "archived", source: "user" });
    store.emit("task:moved", { task: makeTask("TASK-D"), from: "todo", to: "archived", source: "user" });

    await Promise.all([
      (executor as any).pendingTaskDisposals.get("TASK-C"),
      (executor as any).pendingTaskDisposals.get("TASK-D"),
    ]);

    expect(activeSessionRegistry.pathsForTask("TASK-C")).toHaveLength(0);
    expect(activeSessionRegistry.pathsForTask("TASK-D")).toHaveLength(0);
  });

  it("sweeps a leaked registry entry with no in-memory session on archive", async () => {
    const { executor, store } = makeExecutor();

    // Simulate a LEAKED entry: registered directly in the registry with no corresponding
    // in-memory activeSessions/activeStepExecutors/activeWorkflowStepSessions entry, so the
    // abort call itself finds nothing to dispose — only the sweep clears it.
    activeSessionRegistry.registerPath(`${SHARED_ROOT}-leak`, { taskId: "TASK-E", kind: "workflow-step", ownerKey: "TASK-E#workflow-step" });
    expect(activeSessionRegistry.isPathActive(`${SHARED_ROOT}-leak`)).toBe(true);

    store.emit("task:moved", { task: makeTask("TASK-E"), from: "in-review", to: "archived", source: "user" });
    await (executor as any).pendingTaskDisposals.get("TASK-E");

    expect(activeSessionRegistry.isPathActive(`${SHARED_ROOT}-leak`)).toBe(false);
    expect(activeSessionRegistry.pathsForTask("TASK-E")).toHaveLength(0);
  });

  it("sweeps a leaked registry entry when a task is archived DIRECTLY from in-progress (single task:moved hop, no todo stop)", async () => {
    const { executor, store } = makeExecutor();

    // fn_task_archive can move a live in-progress task straight to archived in one
    // `task:moved` event (from: "in-progress", to: "archived") with no intermediate
    // stop in "todo". Before the branch-ordering fix, this hit the narrower
    // `from === "in-progress"` branch first and skipped the archive-only leaked-entry
    // sweep, so a registry entry with no matching in-memory session would survive.
    activeSessionRegistry.registerPath(`${SHARED_ROOT}-inprogress-leak`, { taskId: "TASK-I", kind: "workflow-step", ownerKey: "TASK-I#workflow-step" });
    expect(activeSessionRegistry.isPathActive(`${SHARED_ROOT}-inprogress-leak`)).toBe(true);

    store.emit("task:moved", { task: makeTask("TASK-I"), from: "in-progress", to: "archived", source: "user" });
    await (executor as any).pendingTaskDisposals.get("TASK-I");

    expect(activeSessionRegistry.isPathActive(`${SHARED_ROOT}-inprogress-leak`)).toBe(false);
    expect(activeSessionRegistry.pathsForTask("TASK-I")).toHaveLength(0);
  });

  it("does NOT clear a held merge lease when a task moves to done or in-review", async () => {
    const { executor, store } = makeExecutor();

    activeSessionRegistry.registerPath(`${SHARED_ROOT}-merge-done`, { taskId: "TASK-F", kind: "ai-merge", ownerKey: "TASK-F#ai-merge" });
    activeSessionRegistry.registerPath(`${SHARED_ROOT}-merge-review`, { taskId: "TASK-G", kind: "workspace-repo-land", ownerKey: "TASK-G#workspace-repo-land" });

    store.emit("task:moved", { task: makeTask("TASK-F"), from: "in-progress", to: "done", source: "engine" });
    store.emit("task:moved", { task: makeTask("TASK-G"), from: "in-progress", to: "in-review", source: "engine" });

    // These moves go through the existing `from === "in-progress"` branch, which is
    // unrelated to and does not fire the new archive-only sweep — the merge lease survives.
    await Promise.resolve();

    expect(activeSessionRegistry.isPathActive(`${SHARED_ROOT}-merge-done`)).toBe(true);
    expect(activeSessionRegistry.isPathActive(`${SHARED_ROOT}-merge-review`)).toBe(true);
  });

  it("is a no-op that does not throw when archiving a task with no held registry paths", async () => {
    const { executor, store } = makeExecutor();

    expect(() =>
      store.emit("task:moved", { task: makeTask("TASK-H"), from: "triage", to: "archived", source: "user" }),
    ).not.toThrow();

    await (executor as any).pendingTaskDisposals.get("TASK-H");
    expect(activeSessionRegistry.pathsForTask("TASK-H")).toHaveLength(0);
  });

  it("reproduces the original ActiveSessionPathHeldByForeignTaskError before archive, and confirms it is gone after", async () => {
    const { executor, store } = makeExecutor();

    (executor as any).setActiveWorkflowStepSession("NEXT-508", {}, SHARED_ROOT);

    // Before archive: a second task trying to register the same path is rejected.
    expect(() =>
      activeSessionRegistry.registerPath(SHARED_ROOT, { taskId: "NEXT-433", kind: "workflow-step", ownerKey: "NEXT-433#workflow-step" }),
    ).toThrow(ActiveSessionPathHeldByForeignTaskError);

    store.emit("task:moved", { task: makeTask("NEXT-508"), from: "triage", to: "archived", source: "user" });
    await (executor as any).pendingTaskDisposals.get("NEXT-508");

    // After archive: the successor can now acquire the path.
    expect(() =>
      activeSessionRegistry.registerPath(SHARED_ROOT, { taskId: "NEXT-433", kind: "workflow-step", ownerKey: "NEXT-433#workflow-step" }),
    ).not.toThrow();
  });
});

describe("workflow graph column boundaries do not abort their own run", () => {
  it.each(["triage", "in-review"] as const)(
    "keeps the graph runner alive across in-progress → %s",
    async (to) => {
      const { executor, store } = makeExecutor();
      const task = { id: `TASK-GRAPH-${to}`, column: to } as any;
      const abortSpy = vi
        .spyOn(executor as any, "awaitAbortInFlightTaskWork")
        .mockResolvedValue(undefined);
      (store as any).moveTask = vi.fn(async (_taskId: string, column: string) => {
        store.emit("task:moved", {
          task: { ...task, column },
          from: "in-progress",
          to: column,
          source: "engine",
        });
      });

      (executor as any).graphRouting.add(task.id);
      try {
        await (executor as any).buildColumnBoundaryHooks(task).moveTask(to, {
          fromColumn: "in-progress",
          nodeId: to === "triage" ? "plan-replan" : "review",
        });
        await Promise.resolve();

        expect(abortSpy).not.toHaveBeenCalled();
      } finally {
        (executor as any).graphRouting.delete(task.id);
      }
    },
  );

  it("still aborts an external engine move away from in-progress", async () => {
    const { executor, store } = makeExecutor();
    const abortSpy = vi
      .spyOn(executor as any, "awaitAbortInFlightTaskWork")
      .mockResolvedValue(undefined);

    store.emit("task:moved", {
      task: { id: "TASK-EXTERNAL", column: "todo" },
      from: "in-progress",
      to: "todo",
      source: "engine",
    });
    await Promise.resolve();

    expect(abortSpy).toHaveBeenCalledOnce();
  });
});
