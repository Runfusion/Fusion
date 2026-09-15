/*
FNXC:SelfHealingReclaim 2026-09-15-19:20:
FN-429. The `tip-already-merged` / `stale-cached-metadata-ghost-conflict` reclaim does not repair overlap
delivery evidence, yet on FN-428 it destroyed and recreated the checkout and cleared `error`/`status` roughly
every 5 minutes while the resume kept failing on a rewritten predecessor SHA. These cases prove the sweep now
withholds while any overlap episode is still working, names the pending delivery once, and mutates nothing —
and that the ordinary reclaim (including its foreign-trailer veto) is untouched when no wait is pending.
*/
import { EventEmitter } from "node:events";
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
import { withBranchWriteProvenance } from "./branch-write-provenance-store-stub.js";

function createStore(overlapWaits: (() => Promise<unknown[]>) | undefined): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false });
  (emitter as any).listTasks = vi.fn();
  (emitter as any).getTask = vi.fn().mockResolvedValue({ column: "in-review" });
  (emitter as any).updateTask = vi.fn(withBranchWriteProvenance(async () => undefined));
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).logEntry = vi.fn().mockResolvedValue(undefined);
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  // Declared intent: this double either has a pending overlap wait or explicitly has none.
  if (overlapWaits) (emitter as any).listTaskOverlapWaits = vi.fn(overlapWaits);
  return emitter;
}

const ghostTask = {
  id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/ghost-overlap",
  baseCommitSha: "m0", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed", error: "OverlapResumeSynchronizationError", lineageId: "lin-1",
};

describe("self-healing withholds tip-already-merged reclaim on pending overlap evidence (FN-429)", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  const mockSweepTask = (task: any) => {
    (store.listTasks as any).mockResolvedValue([]);
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([task]);
  };

  const arm = (overlapWaits: (() => Promise<unknown[]>) | undefined) => {
    store = createStore(overlapWaits);
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test" });
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({
      kind: "tip-already-merged", livePath: null, tipSha: "1234567890abcdef", integrationRef: "main",
    } as any);
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    execMock.mockReset();
    execMock.mockResolvedValue("");
  });

  it.each(["observed", "analyzing", "freshness-pending"] as const)("withholds and logs once while an episode is %s", async (phase) => {
    arm(async () => [{ taskId: "FN-9001", episodeId: "episode-1", blockerTaskId: "FN-A", phase }]);

    for (let sweep = 0; sweep < 3; sweep += 1) {
      mockSweepTask(ghostTask);
      expect(await manager.reclaimSelfOwnedBranchConflicts()).toBe(0);
    }

    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalledWith(expect.stringContaining("git branch -D"), expect.anything());
    expect((store as any).recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ mutationType: "branch:auto-reclaim" }));
    const withheld = (store.logEntry as any).mock.calls.filter((call: any[]) => String(call[1]).includes("tip-already-merged withheld"));
    expect(withheld).toHaveLength(1);
    expect(String(withheld[0][1])).toContain(`FN-A is still ${phase}`);
  });

  it("treats an unreadable episode read as pending evidence and never reclaims", async () => {
    arm(async () => { throw new Error("overlap wait read unavailable"); });
    mockSweepTask(ghostTask);

    expect(await manager.reclaimSelfOwnedBranchConflicts()).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-9001", expect.stringContaining("tip-already-merged withheld"));
  });

  it("keeps the ordinary reclaim intact when no overlap wait is pending", async () => {
    arm(async () => [{ taskId: "FN-9001", episodeId: "episode-1", blockerTaskId: "FN-A", phase: "delivered" }]);
    mockSweepTask(ghostTask);

    expect(await manager.reclaimSelfOwnedBranchConflicts()).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-9001", expect.objectContaining({ worktree: null, branch: null, baseCommitSha: null, status: null, error: null }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-9001", expect.stringContaining("[recovery] tip-already-merged FN-9001"));
  });

  it("keeps the foreign-trailer veto ahead of reclaim when no overlap wait is pending", async () => {
    arm(async () => []);
    mockSweepTask({ ...ghostTask, id: "FN-9002", branch: "fusion/fn-9002" });
    execMock.mockImplementation(async (cmd: string) => {
      if (cmd.startsWith("git show -s --format=%s%x1f%b")) return "feat(FN-OTHER): foreign work\x1fFusion-Task-Id: FN-OTHER\n";
      if (cmd.startsWith("git merge-base")) return "base-sha\n";
      if (cmd.includes("git diff --quiet")) throw new Error("unique content");
      return "";
    });

    expect(await manager.reclaimSelfOwnedBranchConflicts()).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect((store.logEntry as any).mock.calls.some((call: any[]) => String(call[1]).includes("tip-already-merged withheld"))).toBe(false);
  });
});
