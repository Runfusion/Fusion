import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { inspectBranchConflict } from "../branch-conflicts.js";

const execAsync = promisify(exec);

async function run(command: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(command, { cwd, encoding: "utf-8" });
  return stdout.trim();
}

describe("inspectBranchConflict ghost references", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setupRepo() {
    const repoDir = await mkdtemp(path.join(tmpdir(), "fn-4508-branch-conflict-"));
    dirs.push(repoDir);
    await run("git init -b main", repoDir);
    await run("git config user.email test@example.com", repoDir);
    await run("git config user.name 'Test User'", repoDir);
    await writeFile(path.join(repoDir, "note.txt"), "base\n", "utf-8");
    await run("git add note.txt && git commit -m 'chore: base'", repoDir);
    return repoDir;
  }

  it("returns stale-resolved when live branch mapping points to missing ghost path", async () => {
    const repoDir = await setupRepo();
    await run("git checkout -b fusion/fn-9999", repoDir);
    await run("git checkout main", repoDir);
    const livePath = path.join(repoDir, ".worktrees/ghost-cat");
    await run(`git worktree add ${JSON.stringify(livePath)} fusion/fn-9999`, repoDir);
    await rm(livePath, { recursive: true, force: true });
    const conflictingPath = path.join(repoDir, "conflict-path");
    await mkdir(conflictingPath, { recursive: true });

    const result = await inspectBranchConflict({
      repoDir,
      branchName: "fusion/fn-9999",
      conflictingWorktreePath: conflictingPath,
      requestingTaskId: "FN-9999",
      ownerTaskId: "FN-9999",
      startPoint: "main",
    });

    expect(result.kind).toBe("stale-resolved");
  });

  it("returns tip-already-merged when branch tip is reachable from main despite stale startPoint", async () => {
    const repoDir = await setupRepo();
    const staleStartPoint = await run("git rev-parse HEAD", repoDir);
    for (let i = 0; i < 5; i += 1) {
      await appendFile(path.join(repoDir, "note.txt"), `m${i}\n`, "utf-8");
      await run(`git add note.txt && git commit -m 'chore: main-${i}'`, repoDir);
    }
    await run("git branch fusion/fn-9999", repoDir);
    const livePath = path.join(repoDir, "wt-live");
    await run(`git worktree add ${JSON.stringify(livePath)} fusion/fn-9999`, repoDir);
    const conflictingPath = path.join(repoDir, "conflict-live");
    await mkdir(conflictingPath, { recursive: true });

    const result = await inspectBranchConflict({
      repoDir,
      branchName: "fusion/fn-9999",
      conflictingWorktreePath: conflictingPath,
      requestingTaskId: "FN-9999",
      ownerTaskId: "FN-9999",
      startPoint: staleStartPoint,
    });

    expect(result.kind).toBe("tip-already-merged");
    if (result.kind === "tip-already-merged") {
      expect(result.integrationRef).toBe("main");
      expect(result.tipSha).toBe(await run("git rev-parse fusion/fn-9999", repoDir));
    }
  });

  it("returns tip-already-merged when startPoint is HEAD and tip is ancestor", async () => {
    const repoDir = await setupRepo();
    await run("git branch fusion/fn-9999", repoDir);
    const livePath = path.join(repoDir, "wt-head");
    await run(`git worktree add ${JSON.stringify(livePath)} fusion/fn-9999`, repoDir);
    const conflictingPath = path.join(repoDir, "conflict-head");
    await mkdir(conflictingPath, { recursive: true });

    const result = await inspectBranchConflict({
      repoDir,
      branchName: "fusion/fn-9999",
      conflictingWorktreePath: conflictingPath,
      requestingTaskId: "FN-9999",
      ownerTaskId: "FN-9999",
      startPoint: "HEAD",
    });

    expect(result.kind).toBe("tip-already-merged");
  });

  it("keeps genuine live-foreign conflicts unchanged", async () => {
    const repoDir = await setupRepo();
    await run("git checkout -b topic/other", repoDir);
    await appendFile(path.join(repoDir, "note.txt"), "foreign\n", "utf-8");
    await run("git add note.txt", repoDir);
    await run("git commit -m 'chore: foreign work'", repoDir);
    await run("git checkout main", repoDir);
    const livePath = path.join(repoDir, "wt-foreign");
    await run(`git worktree add ${JSON.stringify(livePath)} topic/other`, repoDir);
    const conflictingPath = path.join(repoDir, "conflict-foreign");
    await mkdir(conflictingPath, { recursive: true });

    const result = await inspectBranchConflict({
      repoDir,
      branchName: "topic/other",
      conflictingWorktreePath: conflictingPath,
      requestingTaskId: "FN-9999",
      ownerTaskId: "FN-9999",
      startPoint: "main",
    });

    expect(result.kind).toBe("live-foreign");
    if (result.kind === "live-foreign") {
      expect(result.error.name).toBe("BranchConflictError");
    }
  });

  it("keeps stale conflictingWorktreePath short-circuit behavior", async () => {
    const repoDir = await setupRepo();
    await run("git branch fusion/fn-9999", repoDir);

    const result = await inspectBranchConflict({
      repoDir,
      branchName: "fusion/fn-9999",
      conflictingWorktreePath: path.join(repoDir, "missing-conflict-path"),
      requestingTaskId: "FN-9999",
      ownerTaskId: "FN-9999",
      startPoint: "main",
    });

    expect(result.kind).toBe("stale");
  });
});
