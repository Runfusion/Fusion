// -nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks, mockedExecSync } from "./executor-test-helpers.js";

/**
 * T8: the integration rebase (and rebase --abort) must run in the INSTANCE
 * worktree — the instance branch is checked out there, so running the rebase
 * from the task's MAIN worktree fails with "branch is already checked out in
 * another worktree". The final fast-forward merge still runs from the main
 * worktree (it advances the target branch checked out there).
 *
 * The shared executor harness routes the promisified `exec` through the
 * `execSync` mock (see executor-test-helpers), so we drive behavior + capture
 * cwds via `mockedExecSync`.
 */
describe("buildForeachWorktreeDeps integrate() cwd (T8)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  function makeDeps() {
    const store = createMockStore();
    store.getTask = vi.fn().mockResolvedValue({
      id: "FN-PAR",
      worktree: "/main/wt",
      branch: "fusion/FN-PAR",
    });
    const executor: any = new TaskExecutor(store, "/root", {});
    // Stub createWorktree so allocateInstanceWorktree records the instance path
    // without touching the filesystem.
    executor.createWorktree = vi.fn(async (branch: string, _path: string) => ({
      path: `/inst/step-${branch}`,
      branch,
    }));
    const deps = executor.buildForeachWorktreeDeps({ id: "FN-PAR", branch: "fusion/FN-PAR" });
    return { executor, deps };
  }

  it("runs rebase in the instance worktree and ff-merge in the main worktree", async () => {
    const { deps } = makeDeps();
    const alloc = await deps.allocateInstanceWorktree(2, "base-sha");
    const calls: Array<{ cmd: string; cwd: string }> = [];
    mockedExecSync.mockImplementation((cmd: string, opts: any) => {
      calls.push({ cmd, cwd: String(opts?.cwd ?? "") });
      return "deadbeef";
    });

    const result = await deps.integrationGitOps.integrate(alloc.branchName, 2);
    expect(result.kind).toBe("integrated");

    const rebase = calls.find((c) => c.cmd.startsWith("git rebase ") && !c.cmd.includes("--abort"));
    const merge = calls.find((c) => c.cmd.startsWith("git merge --ff-only"));
    expect(rebase?.cwd).toBe(`/inst/step-${alloc.branchName}`); // instance worktree
    expect(merge?.cwd).toBe("/main/wt"); // main worktree
  });

  it("falls back to the main worktree cwd when no instance path is recorded", async () => {
    // Defensive: an integrate() for a stepIndex with no allocated instance path
    // (e.g. shared isolation) must not pass an undefined cwd to the rebase.
    const { deps } = makeDeps();
    const calls: Array<{ cmd: string; cwd: string }> = [];
    mockedExecSync.mockImplementation((cmd: string, opts: any) => {
      calls.push({ cmd, cwd: String(opts?.cwd ?? "") });
      return "deadbeef";
    });

    const result = await deps.integrationGitOps.integrate("fusion/FN-PAR-step-9", 9);
    expect(result.kind).toBe("integrated");
    const rebase = calls.find((c) => c.cmd.startsWith("git rebase ") && !c.cmd.includes("--abort"));
    expect(rebase?.cwd).toBe("/main/wt"); // fallback to main worktree, never undefined
  });
});
