/*
FNXC:Workspace 2026-06-24-15:45 (concurrent workspace tasks — shared browse-root collision regression):
In workspace mode every task runs its agent session rooted at the SHARED browse-only workspace root
(`this.rootDir`); per-sub-repo worktrees are acquired on demand. The session registrations
(executor / step-session / workflow-step) are keyed in the GLOBAL path-keyed activeSessionRegistry,
whose foreign-task guard rejects a second task registering a path already held by a different task.
With the bare root as the key, the SECOND concurrent workspace task failed with
"active-session path <root> is held by task <other>; task <self> may not overwrite it" — so only ONE
task per workspace could ever run (the reported MULT-001 vs MULT-002 failure).

Invariant under test (across ALL session-registration surfaces): two different workspace tasks sharing
the browse-root register concurrently WITHOUT collision, each remains discoverable by liveness
(pathsForTask returns a task-scoped key), and cleanup leaves no leaked entry. Negative control: a
NON-workspace executor (unique worktree path) still rejects a foreign-task overwrite, so the
cross-phase-clobber guard is preserved.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { TaskStore } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { activeSessionRegistry, ActiveSessionPathHeldByForeignTaskError } from "../agents/active-session-registry.js";

const WORKSPACE_ROOT = "/tmp/fusion-test-workspace-root";

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRunContextFor: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
  }) as unknown as TaskStore & EventEmitter;
}

function makeWorkspaceExecutor(): TaskExecutor {
  const executor = new TaskExecutor(createStore(), WORKSPACE_ROOT);
  (executor as any).workspaceConfig = { repos: ["swarmclaw", "OpenVide"] };
  return executor;
}

describe("workspace concurrent session registration", () => {
  beforeEach(() => activeSessionRegistry.clear());
  afterEach(() => activeSessionRegistry.clear());

  it("lets two workspace tasks register executor sessions on the shared browse-root without collision", () => {
    const executor = makeWorkspaceExecutor();

    // Both tasks pass the SAME shared workspace root as worktreePath — the pre-fix collision point.
    expect(() => (executor as any).setActiveSession("MULT-001", {}, WORKSPACE_ROOT)).not.toThrow();
    expect(() => (executor as any).setActiveSession("MULT-002", {}, WORKSPACE_ROOT)).not.toThrow();

    // Each task stays discoverable by liveness via a DISTINCT task-scoped registry key.
    const a = activeSessionRegistry.pathsForTask("MULT-001");
    const b = activeSessionRegistry.pathsForTask("MULT-002");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).not.toEqual(b[0]);
    expect(a[0]).toContain("MULT-001");
    expect(b[0]).toContain("MULT-002");
  });

  it("cleans up the task-scoped session key on deleteActiveSession (no leak)", () => {
    const executor = makeWorkspaceExecutor();
    // The in-memory activeWorktrees Set holds the REAL root; deleteActiveSession must still map it
    // back to the synthetic key it registered.
    (executor as any).addActiveWorktree("MULT-001", WORKSPACE_ROOT);
    (executor as any).setActiveSession("MULT-001", {}, WORKSPACE_ROOT);
    expect(activeSessionRegistry.pathsForTask("MULT-001")).toHaveLength(1);

    (executor as any).deleteActiveSession("MULT-001");
    expect(activeSessionRegistry.pathsForTask("MULT-001")).toHaveLength(0);
  });

  it("does not collide across the step-session and workflow-step surfaces either", () => {
    const executor = makeWorkspaceExecutor();
    expect(() => (executor as any).setActiveStepExecutor("MULT-001", {}, WORKSPACE_ROOT)).not.toThrow();
    expect(() => (executor as any).setActiveStepExecutor("MULT-002", {}, WORKSPACE_ROOT)).not.toThrow();
    expect(() => (executor as any).setActiveWorkflowStepSession("MULT-001", {}, WORKSPACE_ROOT)).not.toThrow();
    expect(() => (executor as any).setActiveWorkflowStepSession("MULT-002", {}, WORKSPACE_ROOT)).not.toThrow();
  });

  it("still rejects a foreign-task overwrite for NON-workspace tasks (clobber guard preserved)", () => {
    const sharedWorktree = "/tmp/fusion-test-single-repo-worktree";
    const executor = new TaskExecutor(createStore(), sharedWorktree); // no workspaceConfig → singular path

    (executor as any).setActiveSession("FN-A", {}, sharedWorktree);
    // A second, different task on the identical real worktree path must still be rejected — this is the
    // cross-phase-clobber protection the workspace fix must not weaken.
    expect(() => (executor as any).setActiveSession("FN-B", {}, sharedWorktree)).toThrow(
      ActiveSessionPathHeldByForeignTaskError,
    );
  });
});
