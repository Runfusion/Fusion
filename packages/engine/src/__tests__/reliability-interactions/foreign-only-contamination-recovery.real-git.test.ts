import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { recoverForeignOnlyContamination } from "../../recovery/foreign-only-contamination.js";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";

const execAsync = promisify(exec);

async function run(command: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(command, { cwd, encoding: "utf-8" });
  return stdout.trim();
}

describe("reliability interaction: foreign-only contamination recovery", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setupRepo() {
    const repoDir = await mkdtemp(path.join(tmpdir(), "fn-4887-ri-"));
    dirs.push(repoDir);
    await run("git init -b main", repoDir);
    await run("git config user.email test@example.com", repoDir);
    await run("git config user.name 'Test User'", repoDir);
    await writeFile(path.join(repoDir, "note.txt"), "base\n", "utf-8");
    await run("git add note.txt && git commit -m 'chore: base'", repoDir);
    const baseSha = await run("git rev-parse HEAD", repoDir);

    await run("git checkout -b fusion/fn-y", repoDir);
    await appendFile(path.join(repoDir, "note.txt"), "foreign-1\n", "utf-8");
    await run("git add note.txt && git commit -m 'feat(FN-7001): y1' -m 'Fusion-Task-Id: FN-7001'", repoDir);
    await appendFile(path.join(repoDir, "note.txt"), "foreign-2\n", "utf-8");
    await run("git add note.txt && git commit -m 'fix(FN-7001): y2' -m 'Fusion-Task-Id: FN-7001'", repoDir);

    await run("git checkout -b fusion/fn-x", repoDir);
    await run("git checkout main", repoDir);
    const worktreePath = path.join(repoDir, "wt-fn-x");
    await run(`git worktree add ${JSON.stringify(worktreePath)} fusion/fn-x`, repoDir);
    dirs.push(worktreePath);
    return { repoDir, baseSha, worktreePath };
  }

  it("reanchors foreign-only branch and preserves foreign branch commits", async () => {
    const { repoDir, baseSha, worktreePath } = await setupRepo();
    const store = {
      moveTask: vi.fn(async () => {}),
      updateTask: vi.fn(async () => {}),
    } as any;
    const runAudit = { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() } as any;

    const result = await recoverForeignOnlyContamination({
      id: "FN-8001",
      branch: "fusion/fn-x",
      worktree: worktreePath,
      baseCommitSha: baseSha,
      baseBranch: "main",
      executionStartBranch: "fusion/fn-y",
    } as any, { repoDir, taskStore: store, runAudit, integrationBranch: "main" });

    expect(result.recovered).toBe(true);
    expect(["reanchor", "branch-discard"]).toContain(result.subtype);
    if (result.subtype === "reanchor") {
      expect(await run("git rev-parse fusion/fn-x", repoDir)).toBe(baseSha);
    }
    expect(await run("git rev-list --count main..fusion/fn-y", repoDir)).toBe("2");
    expect(runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "task:auto-recover-foreign-only-contamination" }));
  });

  it("refuses discard path when active session is present", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const store = {
      moveTask: vi.fn(async () => {}),
      updateTask: vi.fn(async () => {}),
    } as any;
    const runAudit = { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() } as any;

    const missingWorktree = path.join(repoDir, "missing-worktree");
    vi.spyOn(activeSessionRegistry, "isPathActive").mockReturnValue(true);

    const result = await recoverForeignOnlyContamination({
      id: "FN-8002",
      branch: "fusion/fn-x",
      worktree: missingWorktree,
      baseCommitSha: baseSha,
      baseBranch: "main",
      executionStartBranch: "fusion/fn-y",
    } as any, { repoDir, taskStore: store, runAudit, integrationBranch: "main" });

    expect(result.recovered).toBe(false);
    expect(result.reason).toBe("active-session");
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});
