/*
FNXC:PlanReviewWorktree 2026-07-25-20:40 (concurrent root-rooted step sessions — single-repo regression):
Read-only graph nodes that need no worktree run rooted at the executor's `rootDir`, and a todo task has
no worktree of its own. Plan Review is the canonical one. With the bare root as the activeSessionRegistry
key, the SECOND task to reach such a node failed with "active-session path <root> is held by task <other>;
task <self> may not overwrite it" — narrated as a Plan Review provider failure, retried in place against a
hold retrying can never clear, then parked once the budget was spent (reported: FN-1398 holding
/home/ubuntu/dev/freemap-svelte while FN-1403 planned).

Invariant under test: on a plain single-repo project (NO workspaceConfig — the workspace fix did not cover
this), two different tasks register root-rooted sessions concurrently across ALL THREE registration
surfaces (executor / step-session / workflow-step) without collision, each stays discoverable by liveness,
and each delete surface cleans up its synthetic key. Negative control: a genuine shared per-task worktree
path (not the root) still rejects the foreign-task overwrite.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { TaskStore } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { activeSessionRegistry, ActiveSessionPathHeldByForeignTaskError } from "../agents/active-session-registry.js";

const ROOT = "/tmp/fusion-test-single-repo-project-root";

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRunContextFor: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
  }) as unknown as TaskStore & EventEmitter;
}

/** Plain single-repo executor: no workspaceConfig, so the pre-fix bare-root key applied. */
function makeSingleRepoExecutor(): TaskExecutor {
  return new TaskExecutor(createStore(), ROOT);
}

describe("root-rooted concurrent session registration (single-repo project)", () => {
  beforeEach(() => activeSessionRegistry.clear());
  afterEach(() => activeSessionRegistry.clear());

  const surfaces: Array<[string, (executor: TaskExecutor, taskId: string) => void]> = [
    ["setActiveSession", (executor, taskId) => (executor as any).setActiveSession(taskId, {}, ROOT)],
    ["setActiveStepExecutor", (executor, taskId) => (executor as any).setActiveStepExecutor(taskId, {}, ROOT)],
    ["setActiveWorkflowStepSession", (executor, taskId) => (executor as any).setActiveWorkflowStepSession(taskId, {}, ROOT)],
  ];

  for (const [name, register] of surfaces) {
    it(`lets two tasks register concurrently on the repo root via ${name}`, () => {
      const executor = makeSingleRepoExecutor();

      expect(() => register(executor, "FN-1398")).not.toThrow();
      expect(() => register(executor, "FN-1403")).not.toThrow();

      const holder = activeSessionRegistry.pathsForTask("FN-1398");
      const planner = activeSessionRegistry.pathsForTask("FN-1403");
      expect(holder).toHaveLength(1);
      expect(planner).toHaveLength(1);
      expect(holder[0]).not.toEqual(planner[0]);
      expect(activeSessionRegistry.isPathActive(holder[0])).toBe(true);
      expect(activeSessionRegistry.isPathActive(planner[0])).toBe(true);
    });
  }

  const cleanups: Array<[string, (executor: TaskExecutor, taskId: string) => void, (executor: TaskExecutor, taskId: string) => void]> = [
    [
      "deleteActiveSession",
      (executor, taskId) => (executor as any).setActiveSession(taskId, {}, ROOT),
      (executor, taskId) => (executor as any).deleteActiveSession(taskId),
    ],
    [
      "deleteActiveStepExecutor",
      (executor, taskId) => (executor as any).setActiveStepExecutor(taskId, {}, ROOT),
      (executor, taskId) => (executor as any).deleteActiveStepExecutor(taskId),
    ],
    [
      "deleteActiveWorkflowStepSession",
      (executor, taskId) => (executor as any).setActiveWorkflowStepSession(taskId, {}, ROOT),
      (executor, taskId) => (executor as any).deleteActiveWorkflowStepSession(taskId),
    ],
  ];

  for (const [name, register, remove] of cleanups) {
    it(`cleans up the task-scoped root key on ${name} (no leak)`, () => {
      const executor = makeSingleRepoExecutor();
      // The in-memory activeWorktrees Set holds the REAL root; the delete surface must map it back to
      // the synthetic key that was registered.
      (executor as any).addActiveWorktree("FN-1403", ROOT);
      register(executor, "FN-1403");
      expect(activeSessionRegistry.pathsForTask("FN-1403")).toHaveLength(1);

      remove(executor, "FN-1403");
      expect(activeSessionRegistry.pathsForTask("FN-1403")).toHaveLength(0);
    });
  }

  it("still rejects a foreign-task overwrite on a shared per-task worktree path", () => {
    const executor = makeSingleRepoExecutor();
    const sharedWorktree = `${ROOT}-worktrees/shared`;

    (executor as any).setActiveWorkflowStepSession("FN-1398", {}, sharedWorktree);
    expect(() => (executor as any).setActiveWorkflowStepSession("FN-1403", {}, sharedWorktree)).toThrow(
      ActiveSessionPathHeldByForeignTaskError,
    );
  });
});
