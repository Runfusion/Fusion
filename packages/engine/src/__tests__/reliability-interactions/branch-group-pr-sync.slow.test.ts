import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { type TaskStore } from "@fusion/core";
import { aiMergeTask } from "../../merger.js";
import type { SyncGroupPrFn } from "../../group-merge-coordinator.js";
import { git, hasGit, makeReliabilityFixture } from "./_helpers.js";

/**
 * U6 (R6): keep the single managed group PR in sync as members land. These tests
 * drive `aiMergeTask` (which fires `recordBranchGroupMemberLanding`) and assert
 * the injected `syncGroupPr` callback is invoked with the latest member state
 * when the group has a persisted open PR — and that a sync failure is non-fatal.
 */
async function stageMergeBranch(store: TaskStore, rootDir: string, taskId: string, fileName: string): Promise<void> {
  const task = await store.getTask(taskId);
  const branch = `fusion/${taskId.toLowerCase()}`;
  const worktreePath = join(`${rootDir}-worktrees`, taskId.toLowerCase());
  await store.updateTask(taskId, {
    baseBranch: "",
    branch,
    column: "in-review",
    worktree: worktreePath,
    steps: (task?.steps ?? []).map((step) => ({ ...step, status: "done" as const })),
    currentStep: (task?.steps ?? []).length ?? 0,
  } as any);

  git(rootDir, `git checkout -b ${branch}`);
  await mkdir(join(rootDir, "packages/engine/src"), { recursive: true });
  git(rootDir, `sh -c 'printf ${JSON.stringify(`export const ${fileName} = true;\n`)} > ${JSON.stringify(`packages/engine/src/${fileName}.ts`)}'`);
  git(rootDir, `git add ${JSON.stringify(`packages/engine/src/${fileName}.ts`)}`);
  git(rootDir, `git commit -m ${JSON.stringify(`feat: add ${fileName}`)}`);
  git(rootDir, "git checkout main");
  await store.enqueueMergeQueue(taskId);
}

describe("U6: group PR sync on member landing", () => {
  it.skipIf(!hasGit)("pushes an updated body when a member lands and the group PR is open", async () => {
    const fixture = await makeReliabilityFixture({ taskId: "FN-U6-SYNC-A", settings: { testMode: true, autoMerge: true } as any });
    try {
      const { rootDir, store, task } = fixture;
      const second = await store.createTask({
        id: "FN-U6-SYNC-B",
        title: "U6 Second",
        description: "second member",
        column: "in-review",
        baseBranch: "main",
        branch: "fusion/fn-u6-sync-b",
        prompt: "## File Scope\n- packages/engine/src/**/*.ts\n",
        steps: [],
      } as any);

      const group = store.createBranchGroup({
        sourceType: "planning",
        sourceId: "PS-U6-A",
        branchName: "fusion/groups/fn-u6-a",
        autoMerge: true,
      });
      await store.setTaskBranchGroup(task.id, group.id);
      await store.setTaskBranchGroup(second.id, group.id);
      await store.updateTask(task.id, { branchContext: { groupId: group.id, source: "planning", assignmentMode: "shared" } } as any);
      await store.updateTask(second.id, { branchContext: { groupId: group.id, source: "planning", assignmentMode: "shared" } } as any);

      // Simulate a group PR already created and open (as if a prior promotion ran).
      store.updateBranchGroup(group.id, { prState: "open", prNumber: 99, prUrl: "https://github.com/o/r/pull/99" });

      const syncCalls: Array<{ prNumber: number | null; memberIds: string[] }> = [];
      const syncGroupPr: SyncGroupPrFn = vi.fn(async ({ group: g, members }) => {
        syncCalls.push({ prNumber: g.prNumber, memberIds: members.map((m: { id: string }) => m.id) });
        return { prNumber: g.prNumber!, prUrl: g.prUrl!, prState: "open" as const };
      });

      // T14: the sync is fire-and-forget; capture the background promise so the
      // assertions below observe it deterministically rather than racing it.
      let syncSettled: Promise<void> = Promise.resolve();
      await stageMergeBranch(store, rootDir, second.id, "fnU6SyncB");
      const merge = await aiMergeTask(store, rootDir, second.id, {
        syncGroupPr,
        onGroupPrSyncSettled: (settled) => {
          syncSettled = settled;
        },
      });
      expect(merge.merged).toBe(true);
      await syncSettled;

      // Sync callback fired with the persisted PR number and the group's members.
      expect(syncCalls.length).toBeGreaterThanOrEqual(1);
      expect(syncCalls[0].prNumber).toBe(99);
      expect(syncCalls[0].memberIds).toEqual(expect.arrayContaining([task.id, second.id]));
      // No duplicate PR creation — prState stays open, prNumber unchanged.
      expect(store.getBranchGroup(group.id)?.prNumber).toBe(99);
      expect(store.getBranchGroup(group.id)?.prState).toBe("open");
    } finally {
      await fixture.cleanup();
    }
  }, 45_000);

  it.skipIf(!hasGit)("does not call sync when the group has no persisted PR", async () => {
    const fixture = await makeReliabilityFixture({ taskId: "FN-U6-SYNC-NOPR", settings: { testMode: true, autoMerge: true } as any });
    try {
      const { rootDir, store, task } = fixture;
      const group = store.createBranchGroup({
        sourceType: "planning",
        sourceId: "PS-U6-NOPR",
        branchName: "fusion/groups/fn-u6-nopr",
        autoMerge: true,
      });
      await store.setTaskBranchGroup(task.id, group.id);
      await store.updateTask(task.id, { branchContext: { groupId: group.id, source: "planning", assignmentMode: "shared" } } as any);

      const syncGroupPr: SyncGroupPrFn = vi.fn(async ({ group: g }) => ({ prNumber: 0, prUrl: "", prState: "none" as const }));

      await stageMergeBranch(store, rootDir, task.id, "fnU6NoPr");
      const merge = await aiMergeTask(store, rootDir, task.id, { syncGroupPr });
      expect(merge.merged).toBe(true);
      expect(syncGroupPr).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  }, 45_000);

  it.skipIf(!hasGit)("a sync failure is non-fatal: the landing still succeeds and prState is unchanged", async () => {
    const fixture = await makeReliabilityFixture({ taskId: "FN-U6-SYNC-FAIL", settings: { testMode: true, autoMerge: true } as any });
    try {
      const { rootDir, store, task } = fixture;
      const group = store.createBranchGroup({
        sourceType: "planning",
        sourceId: "PS-U6-FAIL",
        branchName: "fusion/groups/fn-u6-fail",
        autoMerge: true,
      });
      await store.setTaskBranchGroup(task.id, group.id);
      await store.updateTask(task.id, { branchContext: { groupId: group.id, source: "planning", assignmentMode: "shared" } } as any);
      store.updateBranchGroup(group.id, { prState: "open", prNumber: 7, prUrl: "https://github.com/o/r/pull/7" });

      const syncGroupPr: SyncGroupPrFn = vi.fn(async () => {
        throw new Error("github down");
      });

      let syncSettled: Promise<void> = Promise.resolve();
      await stageMergeBranch(store, rootDir, task.id, "fnU6Fail");
      const merge = await aiMergeTask(store, rootDir, task.id, {
        syncGroupPr,
        onGroupPrSyncSettled: (settled) => {
          syncSettled = settled;
        },
      });
      expect(merge.merged).toBe(true);
      await syncSettled;
      expect(syncGroupPr).toHaveBeenCalled();
      // prState/prNumber unchanged despite the sync failure (retryable next landing).
      expect(store.getBranchGroup(group.id)?.prState).toBe("open");
      expect(store.getBranchGroup(group.id)?.prNumber).toBe(7);
    } finally {
      await fixture.cleanup();
    }
  }, 45_000);

  it.skipIf(!hasGit)("reconciles prState when the persisted PR is closed/merged out-of-band", async () => {
    const fixture = await makeReliabilityFixture({ taskId: "FN-U6-SYNC-OOB", settings: { testMode: true, autoMerge: true } as any });
    try {
      const { rootDir, store, task } = fixture;
      const group = store.createBranchGroup({
        sourceType: "planning",
        sourceId: "PS-U6-OOB",
        branchName: "fusion/groups/fn-u6-oob",
        autoMerge: true,
      });
      await store.setTaskBranchGroup(task.id, group.id);
      await store.updateTask(task.id, { branchContext: { groupId: group.id, source: "planning", assignmentMode: "shared" } } as any);
      store.updateBranchGroup(group.id, { prState: "open", prNumber: 13, prUrl: "https://github.com/o/r/pull/13" });

      // GitHub reports the PR merged out-of-band; sync returns the reconciled state.
      const syncGroupPr: SyncGroupPrFn = vi.fn(async ({ group: g }) => ({
        prNumber: g.prNumber!,
        prUrl: g.prUrl!,
        prState: "merged" as const,
      }));

      let syncSettled: Promise<void> = Promise.resolve();
      await stageMergeBranch(store, rootDir, task.id, "fnU6Oob");
      const merge = await aiMergeTask(store, rootDir, task.id, {
        syncGroupPr,
        onGroupPrSyncSettled: (settled) => {
          syncSettled = settled;
        },
      });
      expect(merge.merged).toBe(true);
      await syncSettled;
      // The merger persists the reconciled prState rather than leaving stale "open".
      expect(store.getBranchGroup(group.id)?.prState).toBe("merged");
    } finally {
      await fixture.cleanup();
    }
  }, 45_000);

});
