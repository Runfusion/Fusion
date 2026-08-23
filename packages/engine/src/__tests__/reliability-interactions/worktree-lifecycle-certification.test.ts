/*
FNXC:WorktreeLifecycleCertification 2026-08-17-20:59:
Certification suite for the invariant "a task's worktree is held across the full lifecycle".
Motivating incident: a user's worktree was lost between in-review and in-progress. Root cause
anatomy is a two-step: (1) a self-healing sweep nulls `task.worktree` while the card idles in
review — the in-review branch rebind did this unconditionally as part of a *branch* repair —
then (2) `scanIdleWorktrees` no longer counts the directory as active, so the idle sweep / cap
enforcement `git worktree remove`s it, making the loss permanent.

This suite pins:
- worktree + branch metadata and the on-disk directory survive every in-progress ↔ in-review
  transition, including idle-in-review maintenance ticks (branch rebind + metadata reconcile);
- the branch-rebind sweep preserves a live checkout that is checked out on the rebound branch
  (and still clears a dangling pointer whose directory is gone — the legacy behavior);
- a worktree referenced by an unfinished task is never classified idle/reapable, and nulling
  the metadata is precisely what makes it reapable (the two-step mechanism itself).

Real git + real PG; reliability lane (serialized) — deliberately NOT gate-eligible.
*/
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  git,
  hasGit,
  hasPg,
  makeReliabilityFixture,
  type ReliabilityFixture,
} from "./_helpers.js";
import { scanIdleWorktrees } from "../../worktree/worktree-pool.js";

const describeCertification = hasGit && hasPg ? describe : describe.skip;

type CertFixture = {
  fx: ReliabilityFixture;
  taskId: string;
  canonicalBranch: string;
  /* Canonical (realpath) project root: macOS tmpdirs are symlinks (/var → /private/var) and
     `getRegisteredWorktreePaths` canonicalizes, so scans must run against the real path or every
     "not idle" assertion passes vacuously against an empty registered set. */
  rootReal: string;
  worktreePath: string;
};

async function readTask(cert: CertFixture) {
  // Read the persisted row, not the write-through cache, so assertions certify storage.
  cert.fx.store.taskCache.clear();
  const task = await cert.fx.store.getTask(cert.taskId);
  if (!task) throw new Error(`certification task ${cert.taskId} disappeared`);
  return task;
}

/**
 * Build a fixture whose task holds a REAL registered git worktree checked out on the
 * canonical fusion branch with one commit of unique work (aheadCount > 0), mirroring a
 * card that finished implementation and is moving through review.
 * The store owns id assignment, so everything derives from `fx.task.id`.
 */
async function makeCertFixture(input?: { column?: string; brokenBranchBinding?: boolean }): Promise<CertFixture> {
  const fx = await makeReliabilityFixture({
    task: { column: input?.column ?? "in-progress" },
  });
  const taskId = fx.task.id;
  const canonicalBranch = `fusion/${taskId.toLowerCase()}`;
  const rootReal = realpathSync(fx.rootDir);
  const worktreesDir = join(rootReal, ".worktrees");
  mkdirSync(worktreesDir, { recursive: true });
  git(fx.rootDir, `git branch ${canonicalBranch}`);
  const worktreePath = join(worktreesDir, taskId.toLowerCase());
  git(fx.rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${canonicalBranch}`);
  await writeFile(join(worktreePath, "work.txt"), "unique work\n", "utf-8");
  git(worktreePath, "git add work.txt");
  git(worktreePath, 'git commit -m "feat: unique work"');
  await fx.store.updateTask(taskId, {
    worktree: worktreePath,
    branch: input?.brokenBranchBinding ? `${canonicalBranch}-renamed-away` : canonicalBranch,
    /* FNXC:BranchNaming 2026-08-23-18:51: a branch write is a provenance boundary
       (`updateTaskUnlockedImpl`); without an explicit origin this fixture threw before any
       certification scenario ran. The engine is what binds a task to its worktree branch. */
    branchWriteOrigin: "engine",
  } as never);
  return { fx, taskId, canonicalBranch, rootReal, worktreePath };
}

async function expectHeld(cert: CertFixture, context: string): Promise<void> {
  const task = await readTask(cert);
  expect(task.worktree, `${context}: task.worktree`).toBe(cert.worktreePath);
  expect(task.branch, `${context}: task.branch`).toBe(cert.canonicalBranch);
  expect(existsSync(cert.worktreePath), `${context}: directory on disk`).toBe(true);
  const idle = await scanIdleWorktrees(cert.rootReal, cert.fx.store, cert.fx.settings);
  expect(idle, `${context}: not idle/reapable`).not.toContain(cert.worktreePath);
}

describeCertification("worktree lifecycle certification", () => {
  let cert: CertFixture | undefined;

  afterEach(async () => {
    await cert?.fx.cleanup();
    cert = undefined;
  });

  it("holds worktree metadata and directory across in-progress ↔ in-review transitions with idle-review sweeps", async () => {
    cert = await makeCertFixture({ column: "in-progress" });
    await expectHeld(cert, "seeded in-progress");

    // Implementation done → review.
    await cert.fx.store.moveTask(cert.taskId, "in-review");
    await expectHeld(cert, "after move to in-review");

    // The card idles in review while maintenance ticks run. An intact binding must be a no-op.
    const rebind = await cert.fx.manager.reconcileInReviewBranchRebind();
    expect(rebind.outcomes).toEqual([
      { taskId: cert.taskId, result: "skipped", reason: "binding-intact" },
    ]);
    await cert.fx.manager.reconcileTaskWorktreeMetadata();
    await expectHeld(cert, "after idle-in-review maintenance sweeps");

    // The reported boundary: review rebounds back to in-progress. The checkout must survive.
    await cert.fx.store.moveTask(cert.taskId, "in-progress");
    await expectHeld(cert, "after rebound to in-progress");

    // And forward into review again.
    await cert.fx.store.moveTask(cert.taskId, "in-review");
    await expectHeld(cert, "after re-entering in-review");
  });

  it("branch rebind preserves a live checkout that is checked out on the rebound branch", async () => {
    // The incident shape: the card sits in review with a broken `branch` binding while the
    // canonical branch (with unique work) and its worktree are alive and well.
    cert = await makeCertFixture({ column: "in-review", brokenBranchBinding: true });

    const result = await cert.fx.manager.reconcileInReviewBranchRebind();
    expect(result.repaired).toBe(1);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        taskId: cert.taskId,
        result: "applied",
        branch: cert.canonicalBranch,
        preservedWorktree: true,
      }),
    ]);
    await expectHeld(cert, "after branch rebind");
  });

  it("branch rebind still clears a dangling worktree pointer whose directory is gone", async () => {
    cert = await makeCertFixture({ column: "in-review", brokenBranchBinding: true });
    // Simulate the directory having been legitimately removed out-of-band.
    git(cert.fx.rootDir, `git worktree remove --force ${JSON.stringify(cert.worktreePath)}`);
    expect(existsSync(cert.worktreePath)).toBe(false);

    const result = await cert.fx.manager.reconcileInReviewBranchRebind();
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        taskId: cert.taskId,
        result: "applied",
        branch: cert.canonicalBranch,
        preservedWorktree: false,
      }),
    ]);
    const task = await readTask(cert);
    expect(task.branch).toBe(cert.canonicalBranch);
    expect(task.worktree ?? null).toBeNull();
  });

  it("nulling task.worktree is exactly what makes the directory reap-eligible (two-step mechanism)", async () => {
    cert = await makeCertFixture({ column: "in-review" });
    await expectHeld(cert, "metadata intact");

    // Sever the metadata the way the pre-fix rebind did, and the directory becomes idle prey.
    await cert.fx.store.updateTask(cert.taskId, { worktree: null } as never);
    // The scan reads through the startup slim-list memo; drop it so the scan sees the severed row.
    cert.fx.store.clearStartupSlimListMemo();
    const idle = await scanIdleWorktrees(cert.rootReal, cert.fx.store, cert.fx.settings);
    expect(idle).toContain(cert.worktreePath);
  });
});
