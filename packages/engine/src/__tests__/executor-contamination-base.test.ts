import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedExec, resetExecutorMocks } from "./executor-test-helpers.js";

/**
 * FN-4417 regression: the contamination check must compute its own fresh
 * merge-base against the integration branch, not reuse `task.baseCommitSha`.
 *
 * Before FN-4417, on a freshly pool-acquired worktree (branch force-reset to
 * current main) the executor passed `task.baseCommitSha` to the contamination
 * `git log <base>..<branch>` query. When that stored SHA was stale, every
 * legitimately-merged commit on main since the stale SHA appeared as a
 * "foreign task-attributed commit" and the task was paused with
 * `pausedReason: "branch-cross-contamination"`. FN-4403 hit this with 157
 * false-positive foreign commits across ~39 unrelated FN-* tasks.
 */
describe("resolveContaminationBaseRef (FN-4417)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("returns the current merge-base with origin/main, ignoring task.baseCommitSha", async () => {
    const calls: string[] = [];
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      calls.push(String(cmd));
      if (String(cmd).includes("merge-base")) {
        cb(null, "fresh_main_sha\n");
      } else {
        cb(null, "");
      }
      return {} as any;
    }) as any);

    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    const result = await (executor as any).resolveContaminationBaseRef(
      "/tmp/test/.worktrees/swift-delta",
    );

    expect(result).toBe("fresh_main_sha");
    // Must have asked for merge-base against local main first (preferred
    // over origin/main, which can lag local main by hundreds of commits on
    // dev machines and re-introduce the FN-4417 false positive). Must not
    // fall back to HEAD~1 (which on a force-reset branch is a commit on
    // main itself).
    const mergeBaseCall = calls.find((c) => c.includes("merge-base"));
    expect(mergeBaseCall).toBeDefined();
    // Local `main` must appear before `origin/main` in the command so the
    // shell `||` fallback prefers it.
    const localMainIdx = mergeBaseCall!.indexOf("merge-base HEAD main");
    const originMainIdx = mergeBaseCall!.indexOf("merge-base HEAD origin/main");
    expect(localMainIdx).toBeGreaterThanOrEqual(0);
    expect(localMainIdx).toBeLessThan(originMainIdx === -1 ? Number.MAX_SAFE_INTEGER : originMainIdx);
    expect(calls.some((c) => c.includes("HEAD~1"))).toBe(false);
  });

  it("returns undefined when neither origin/main nor main resolves", async () => {
    mockedExec.mockImplementation(((_cmd: any, _opts: any, cb: any) => {
      cb(new Error("fatal: no main"), "", "fatal: no main");
      return {} as any;
    }) as any);

    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    const result = await (executor as any).resolveContaminationBaseRef(
      "/tmp/test/.worktrees/swift-delta",
    );

    // Caller (execute()) treats undefined as "skip contamination check"
    // rather than crash the run on git failure.
    expect(result).toBeUndefined();
  });

  it("does NOT fall back to task.baseCommitSha (FN-4417 false-positive guard)", async () => {
    // Simulate the exact FN-4403 condition: merge-base succeeds with a fresh
    // SHA. Even if a stale baseCommitSha is on the task, the contamination
    // base resolver must use the fresh merge-base output.
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      cb(null, String(cmd).includes("merge-base") ? "currentMainSHA\n" : "");
      return {} as any;
    }) as any);

    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    // resolveContaminationBaseRef takes only worktreePath — it has no API
    // surface that accepts task.baseCommitSha. That is the structural
    // guarantee of the fix.
    const result = await (executor as any).resolveContaminationBaseRef(
      "/tmp/test/.worktrees/swift-delta",
    );

    expect(result).toBe("currentMainSHA");
    // Sanity: function arity is 1, not 2 (no baseCommitSha parameter).
    expect((executor as any).resolveContaminationBaseRef.length).toBe(1);
  });
});
