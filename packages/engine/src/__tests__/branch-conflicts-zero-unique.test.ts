// Real-git wallclock under parallel CI load; do not lower per-test timeouts
// without re-measuring under pnpm test:full. (FN-4839)
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { inspectBranchConflict } from "../execution/branch-conflicts.js";

const execAsync = promisify(exec);

async function run(command: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(command, { cwd, encoding: "utf-8" });
  return stdout.trim();
}

describe("inspectBranchConflict zero-unique behavior", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setupRepo() {
    const repoDir = await mkdtemp(path.join(tmpdir(), "fn-4500-branch-conflict-"));
    dirs.push(repoDir);
    await run("git init -b main", repoDir);
    await run("git config user.email test@example.com", repoDir);
    await run("git config user.name 'Test User'", repoDir);
    await writeFile(path.join(repoDir, "note.txt"), "base\n", "utf-8");
    await run("git add note.txt && git commit -m 'chore: base'", repoDir);
    return repoDir;
  }

  it("returns tip-already-merged when branch tip is ancestor of main", async () => {
    const repoDir = await setupRepo();
    await run("git checkout -b fusion/fn-9001", repoDir);
    await run("git checkout main", repoDir);
    const livePath = path.join(repoDir, "wt-live-9001");
    await run(`git worktree add ${JSON.stringify(livePath)} fusion/fn-9001`, repoDir);
    const stalePath = path.join(repoDir, "wt-stale-9001");
    await mkdir(stalePath, { recursive: true });

    const result = await inspectBranchConflict({ repoDir, branchName: "fusion/fn-9001", conflictingWorktreePath: stalePath, requestingTaskId: "FN-9001", ownerTaskId: "FN-9001", startPoint: "main" });
    expect(result.kind).toBe("tip-already-merged");
  }, 20_000);

  it("classifies branch patch already existing upstream as merged/subsumed", async () => {
    const repoDir = await setupRepo();
    await run("git checkout -b fusion/fn-9001", repoDir);
    await appendFile(path.join(repoDir, "note.txt"), "change\n", "utf-8");
    await run("git add note.txt", repoDir);
    await run("git commit -m 'feat(FN-9001): change' -m 'Fusion-Task-Id: FN-9001'", repoDir);
    const branchCommit = await run("git rev-parse HEAD", repoDir);
    await run("git checkout main", repoDir);
    await run(`git cherry-pick ${branchCommit}`, repoDir);

    const livePath = path.join(repoDir, "wt-live-9001-upstream");
    await run(`git worktree add ${JSON.stringify(livePath)} fusion/fn-9001`, repoDir);
    const stalePath = path.join(repoDir, "wt-stale-9001-upstream");
    await mkdir(stalePath, { recursive: true });

    const result = await inspectBranchConflict({ repoDir, branchName: "fusion/fn-9001", conflictingWorktreePath: stalePath, requestingTaskId: "FN-9001", ownerTaskId: "FN-9001", startPoint: "main" });
    expect(["tip-already-merged", "fully-subsumed"]).toContain(result.kind);
  }, 20_000);

  it("returns reclaimable when branch still has unique commit", async () => {
    const repoDir = await setupRepo();
    await run("git checkout -b fusion/fn-9001", repoDir);
    await appendFile(path.join(repoDir, "note.txt"), "unique\n", "utf-8");
    await run("git add note.txt", repoDir);
    await run("git commit -m 'feat(FN-9001): unique' -m 'Fusion-Task-Id: FN-9001'", repoDir);
    await run("git checkout main", repoDir);

    const livePath = path.join(repoDir, "wt-live-9001-unique");
    await run(`git worktree add ${JSON.stringify(livePath)} fusion/fn-9001`, repoDir);
    const stalePath = path.join(repoDir, "wt-stale-9001-unique");
    await mkdir(stalePath, { recursive: true });

    const result = await inspectBranchConflict({ repoDir, branchName: "fusion/fn-9001", conflictingWorktreePath: stalePath, requestingTaskId: "FN-9001", ownerTaskId: "FN-9001", startPoint: "main" });
    expect(result.kind).toBe("reclaimable");
  }, 20_000);

  it("keeps zero-attributed foreign branch as live-foreign", async () => {
    const repoDir = await setupRepo();
    await run("git checkout -b topic/other", repoDir);
    await appendFile(path.join(repoDir, "note.txt"), "other\n", "utf-8");
    await run("git add note.txt", repoDir);
    await run("git commit -m 'chore: other work'", repoDir);
    await run("git checkout main", repoDir);

    const livePath = path.join(repoDir, "wt-live-other");
    await run(`git worktree add ${JSON.stringify(livePath)} topic/other`, repoDir);
    const stalePath = path.join(repoDir, "wt-stale-other");
    await mkdir(stalePath, { recursive: true });

    const result = await inspectBranchConflict({ repoDir, branchName: "topic/other", conflictingWorktreePath: stalePath, requestingTaskId: "FN-9001", ownerTaskId: "FN-9001", startPoint: "main" });
    expect(result.kind).toBe("live-foreign");
  }, 20_000);
});
