import { EventEmitter } from "node:events";
/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2):
These call-arg assertions now include the mutation context the converted sweep passes.
Adding it is what keeps them load-bearing: left at the old arity every
`toHaveBeenCalledWith` here would fail, and every `.not.toHaveBeenCalledWith` would pass
vacuously — an assertion that can no longer fail is worse than one that is red.
*/
import { UNATTRIBUTED_MUTATION_CONTEXT } from "@fusion/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";

const execMock = vi.fn();

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFn: any = (cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    execMock(cmd, opts)
      .then((stdout: string) => callback?.(null, stdout, ""))
      .catch((err: Error) => callback?.(err, "", err.message));
  };
  execFn[promisify.custom] = (cmd: string, opts?: any) =>
    execMock(cmd, opts).then((stdout: string) => ({ stdout, stderr: "" }));
  return { exec: execFn, execSync: vi.fn(), execFile: vi.fn() };
});

import { SelfHealingManager } from "../self-healing.js";
import * as branchConflicts from "../execution/branch-conflicts.js";
import * as worktreePool from "../worktree/worktree-pool.js";

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false });
  (emitter as any).listTasks = vi.fn();
  (emitter as any).updateTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).logEntry = vi.fn().mockResolvedValue(undefined);
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

describe("self-healing ghost branch reclaim", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    store = createStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test" });
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    execMock.mockReset();
    execMock.mockResolvedValue("");
  });

  function mockSweepTask(task: any) {
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([task]);
  }

  it("recovers tip-already-merged FN-4471 signature by clearing cached metadata", async () => {
    mockSweepTask({ id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/ghost-cat", baseCommitSha: "m0", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed", lineageId: "lin-1" });
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "tip-already-merged",
      livePath: null,
      tipSha: "1234567890abcdef",
      integrationRef: "main",
    } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-9001", expect.objectContaining({ worktree: null, branch: null, baseCommitSha: null }), UNATTRIBUTED_MUTATION_CONTEXT);
    expect(store.moveTask).toHaveBeenCalledWith("FN-9001", "todo", expect.objectContaining({ preserveProgress: true, preserveResumeState: true }), UNATTRIBUTED_MUTATION_CONTEXT);
    expect(store.logEntry).toHaveBeenCalledWith("FN-9001", expect.stringContaining("[recovery] tip-already-merged FN-9001"), undefined, UNATTRIBUTED_MUTATION_CONTEXT);
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "branch:auto-reclaim", metadata: expect.objectContaining({ phase: "tip-already-merged" }) }));
  });

  it("invalidates cached metadata on stale-resolved and preserves branch ref", async () => {
    mockSweepTask({ id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/ghost-cat", baseCommitSha: "m0", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" });
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({ kind: "stale-resolved" } as any);

    await manager.reclaimSelfOwnedBranchConflicts();

    expect(store.updateTask).toHaveBeenCalledWith("FN-9001", { worktree: null, branch: null, baseCommitSha: null }, UNATTRIBUTED_MUTATION_CONTEXT);
    expect(execMock).not.toHaveBeenCalledWith(expect.stringContaining("git branch -D"), expect.anything());
  });

  it("keeps genuine live-foreign conflicts parked", async () => {
    mockSweepTask({ id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "topic/other", worktree: "/tmp/live", baseCommitSha: "m0", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" });
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "live-foreign",
      livePath: "/tmp/live",
      error: new branchConflicts.BranchConflictError({
        branchName: "topic/other",
        conflictingWorktreePath: "/tmp/live",
        existingTipSha: "abc",
        strandedCommits: [{ sha: "abc", subject: "x" }],
        startPoint: "main",
        recommendedAction: "manual",
      }),
    } as any);

    await manager.reclaimSelfOwnedBranchConflicts();

    expect(store.updateTask).toHaveBeenCalledWith("FN-9001", expect.objectContaining({ pausedReason: "branch-conflict-unrecoverable", status: "failed" }), UNATTRIBUTED_MUTATION_CONTEXT);
  });

  it("is idempotent after tip-already-merged cleanup", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/ghost", baseCommitSha: "m0", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed", lineageId: "lin-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({ kind: "tip-already-merged", livePath: null, tipSha: "1234567890abcdef", integrationRef: "main" } as any);

    await manager.reclaimSelfOwnedBranchConflicts();
    await manager.reclaimSelfOwnedBranchConflicts();

    const tipLogs = (store.logEntry as any).mock.calls.filter((c: any[]) => String(c[1]).includes("tip-already-merged"));
    expect(tipLogs).toHaveLength(1);
  });

  it("does not half-corrupt state when tip-already-merged cleanup fails", async () => {
    execMock.mockImplementation(async (command: string) => {
      if (command.includes("git branch -D")) throw new Error("delete failed");
      return "";
    });
    mockSweepTask({ id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/live", baseCommitSha: "m0", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" });
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({ kind: "tip-already-merged", livePath: "/tmp/live", tipSha: "1234567890abcdef", integrationRef: "main" } as any);

    await manager.reclaimSelfOwnedBranchConflicts();

    const nullingCalls = (store.updateTask as any).mock.calls.filter((c: any[]) => c[1]?.baseCommitSha === null);
    expect(nullingCalls).toHaveLength(0);
    expect(store.logEntry).toHaveBeenCalledWith("FN-9001", expect.stringContaining("tip-already-merged cleanup failed"), undefined, UNATTRIBUTED_MUTATION_CONTEXT);
  });

  /*
  FNXC:SelfHealingReclaim 2026-08-11-09:38:
  Symptom Verification for the misclassified-cleanup-failure park.

  Original symptom: tasks were failed and paused with `pausedReason: "branch-conflict-unrecoverable"` and the error
  "Task branch conflict: <branch> is not safely reclaimable (...)", where the parenthesised cause was always a
  filesystem message -- `Command failed: git worktree remove --force ...` or `ENOTEMPTY: directory not empty, rmdir
  '.../node_modules/.pnpm/...'` -- never a git conflict. 78 such parks in 16 days on this repo.

  Exact reproduction: a `tip-already-merged` verdict (branch tip is already an ancestor of the integration ref, so the
  branch has nothing unique to lose) whose housekeeping throws.
  Assertion it is gone: the sweep records no `branch-conflict-unrecoverable` park for that task.

  Surface enumeration -- the invariant is "no cleanup failure on an already-merged tip may be reported as a branch
  conflict", so every observed failure shape is asserted rather than only the one that was easiest to reproduce:
    - `git worktree remove --force` failing (FN-8979 / FN-8955 / FN-8932 shape)
    - `ENOTEMPTY ... rmdir node_modules` from a pnpm write race (FN-8908 shape)
    - `git branch -D` failing (covered by the half-corrupt-state test above, extended here to the park assertion)
    - prune runs BEFORE removal, so a stale registration stops causing the failure it would have prevented
    - negative control: a genuine `live-foreign` verdict still parks (see "keeps genuine live-foreign conflicts parked")
  */
  describe("tip-already-merged cleanup failures are not branch conflicts", () => {
    /* The cleanup body is one try block, so WHICH housekeeping step throws does not change the
       classification -- only that something threw. These are the real messages observed on parked
       tasks; they are induced through the `git branch -D` seam because it is the step reachable
       from this suite's exec mock. */
    const CLEANUP_FAILURES: { label: string; message: string }[] = [
      {
        label: "git worktree remove --force failure",
        message: 'Command failed: git worktree remove --force "/repo/.worktrees/grand-crane"',
      },
      {
        label: "pnpm node_modules rmdir race",
        message: "ENOTEMPTY: directory not empty, rmdir '/repo/.worktrees/happy-olive/node_modules/.pnpm/@asamuzakjp+generational-cache@1.0.1'",
      },
      {
        label: "git branch -D failure",
        message: "Command failed: git branch -D",
      },
    ];

    for (const { label, message } of CLEANUP_FAILURES) {
      it(`does not park the task as branch-conflict-unrecoverable on a ${label}`, async () => {
        execMock.mockImplementation(async (command: string) => {
          if (command.includes("git branch -D")) throw new Error(message);
          return "";
        });
        mockSweepTask({ id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/live", baseCommitSha: "m0", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" });
        vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({ kind: "tip-already-merged", livePath: "/tmp/live", tipSha: "1234567890abcdef", integrationRef: "main" } as any);

        await manager.reclaimSelfOwnedBranchConflicts();

        // Positive control: proves the sweep actually reached the tip-already-merged
        // arm and its catch fired. Without this the park assertions below would pass
        // vacuously whenever the task failed the candidate filter.
        expect(store.logEntry).toHaveBeenCalledWith("FN-9001", expect.stringContaining("tip-already-merged cleanup failed"));

        const parks = (store.updateTask as any).mock.calls.filter(
          (c: any[]) => c[1]?.pausedReason === "branch-conflict-unrecoverable",
        );
        expect(parks).toHaveLength(0);
        const failures = (store.updateTask as any).mock.calls.filter((c: any[]) => c[1]?.status === "failed");
        expect(failures).toHaveLength(0);
      });
    }

    it("prunes stale worktree registrations before attempting removal", async () => {
      const gitCommands: string[] = [];
      execMock.mockImplementation(async (command: string) => {
        gitCommands.push(command);
        return "";
      });
      const removeSpy = vi.spyOn(worktreePool, "removeWorktree").mockResolvedValue(undefined as never);
      mockSweepTask({ id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/live", baseCommitSha: "m0", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" });
      vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({ kind: "tip-already-merged", livePath: null, tipSha: "1234567890abcdef", integrationRef: "main" } as any);

      await manager.reclaimSelfOwnedBranchConflicts();

      const pruneIndex = gitCommands.findIndex((c) => c.includes("git worktree prune"));
      const deleteIndex = gitCommands.findIndex((c) => c.includes("git branch -D"));
      expect(pruneIndex).toBeGreaterThanOrEqual(0);
      expect(deleteIndex).toBeGreaterThanOrEqual(0);
      expect(pruneIndex).toBeLessThan(deleteIndex);
      expect(removeSpy).not.toHaveBeenCalled();
    });
  });

  /*
  FNXC:SelfHealingReclaim 2026-07-25-09:40:
  Regression contract for the inherited-tip invariant (FN-1406): the reclaim sweep's `tip-already-merged` arm must
  classify a foreign `Fusion-Task-Id` trailer with merge-base diff proof, not on the trailer alone, so it shares one
  decision (`foreignTipRejection`) with already-merged recovery and branch-misbound recovery.

  Original symptom: FN-1406's branch `fusion/fn-1406` was cut from `main` at FN-1401's landed commit and planning
  ended before any commit. Every sweep logged `[recovery] already-merged rejected FN-1406 ... owner=FN-1401
  reason=foreign-task-tip` and left stale worktree/branch/baseCommitSha metadata on the card instead of reclaiming it.

  Surfaces covered here: pristine inherited tip (reclaim), inherited tip where the base already carries THIS task's
  own commit (still rejected — genuine misbinding), and foreign lineage trailers. The other two callers keep their
  existing real-git rejection coverage in self-healing-already-merged.real-git.test.ts.
  */
  describe("inherited foreign tip on a branch with no unique content", () => {
    const TIP = "9758daadff68aaaabbbbccccddddeeeeffff0000";

    /** Drives the git seam the ownership + diff-proof classification reads: foreign trailer, empty merge-base diff. */
    function mockInheritedForeignTip(options: { trailer: string; baseHasCurrentTask?: boolean }) {
      execMock.mockImplementation(async (command: string) => {
        if (command.includes("git show -s")) return `feat: previous task landed${options.trailer}\n`;
        if (command.includes("git merge-base")) return `${TIP}\n`;
        // `git diff --quiet <mergeBase>..<tip>` exits 0 → no unique task content on the branch.
        if (command.includes("git diff --quiet")) return "";
        if (command.includes("git log --grep")) return options.baseHasCurrentTask ? "deadbeefdeadbeef\n" : "";
        return "";
      });
    }

    function mockTodoSweepTask(task: any) {
      (store.listTasks as any)
        .mockResolvedValueOnce([task])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
    }

    it("reclaims a todo task whose zero-commit branch inherited a foreign task's landed tip", async () => {
      mockInheritedForeignTip({ trailer: "Fusion-Task-Id: FN-1401" });
      mockTodoSweepTask({ id: "FN-1406", column: "todo", checkedOutBy: null, branch: "fusion/fn-1406", worktree: "/tmp/fn-1406", baseCommitSha: TIP });
      vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
        kind: "tip-already-merged",
        livePath: null,
        tipSha: TIP,
        integrationRef: "main",
      } as any);

      const recovered = await manager.reclaimSelfOwnedBranchConflicts();

      expect(recovered).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-1406", expect.objectContaining({ worktree: null, branch: null, baseCommitSha: null }), UNATTRIBUTED_MUTATION_CONTEXT);
      expect(store.logEntry).toHaveBeenCalledWith("FN-1406", expect.stringContaining("[recovery] tip-already-merged FN-1406"), undefined, UNATTRIBUTED_MUTATION_CONTEXT);
      // The symptom line must be gone entirely.
      expect((store.logEntry as any).mock.calls.some((c: any[]) => String(c[1]).includes("already-merged rejected"))).toBe(false);
      expect((store as any).recordRunAuditEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ mutationType: "task:auto-recover-already-merged-rejected" }),
      );
    });

    it("reclaims a zero-commit branch that inherited a foreign lineage tip", async () => {
      mockInheritedForeignTip({ trailer: "Fusion-Task-Lineage: lin-other" });
      mockTodoSweepTask({ id: "FN-1406", column: "todo", checkedOutBy: null, branch: "fusion/fn-1406", worktree: "/tmp/fn-1406", baseCommitSha: TIP, lineageId: "lin-1406" });
      vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
        kind: "tip-already-merged",
        livePath: null,
        tipSha: TIP,
        integrationRef: "main",
      } as any);

      await manager.reclaimSelfOwnedBranchConflicts();

      expect(store.updateTask).toHaveBeenCalledWith("FN-1406", expect.objectContaining({ worktree: null, branch: null, baseCommitSha: null }), UNATTRIBUTED_MUTATION_CONTEXT);
      expect((store.logEntry as any).mock.calls.some((c: any[]) => String(c[1]).includes("already-merged rejected"))).toBe(false);
    });

    it("still rejects a foreign tip when the base already carries this task's own commit", async () => {
      mockInheritedForeignTip({ trailer: "Fusion-Task-Id: FN-1401", baseHasCurrentTask: true });
      mockTodoSweepTask({ id: "FN-1406", column: "todo", checkedOutBy: null, branch: "fusion/fn-1406", worktree: "/tmp/fn-1406", baseCommitSha: TIP });
      vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
        kind: "tip-already-merged",
        livePath: null,
        tipSha: TIP,
        integrationRef: "main",
      } as any);

      const recovered = await manager.reclaimSelfOwnedBranchConflicts();

      expect(recovered).toBe(0);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-1406",
        expect.stringContaining("[recovery] already-merged rejected FN-1406"), undefined, UNATTRIBUTED_MUTATION_CONTEXT,
      );
      expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "task:auto-recover-already-merged-rejected",
        metadata: expect.objectContaining({ reason: "foreign-task-tip", candidateOwner: "FN-1401", phase: "tip-already-merged" }),
      }));
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-1406", expect.objectContaining({ branch: null }), UNATTRIBUTED_MUTATION_CONTEXT);
      expect(execMock).not.toHaveBeenCalledWith(expect.stringContaining("git branch -D"), expect.anything());
    });
  });
});
