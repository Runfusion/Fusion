import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decideAutoPrerebase, probeDivergence, runAutoPrerebase } from "../merge/merger-auto-prerebase.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

// FN-5518 (FN-4807 pattern): real-git rebase scenarios exceed Vitest's 5s default under workspace pnpm test contention; bound but raise the per-test deadline without weakening subprocess guards.
describeIfGit("merger auto-prerebase real-git scenarios", { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repoFixture() {
    const repo = mkdtempSync(join(tmpdir(), "fusion-prerebase-real-"));
    dirs.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    writeFileSync(join(repo, "README.md"), "init\n");
    writeFileSync(join(repo, "AGENTS.md"), "base\n");
    git(repo, "git add README.md AGENTS.md && git commit -m 'init'");
    return repo;
  }

  it("A: fires on hot-file divergence and rebase applies", async () => {
    const repo = repoFixture();
    const base = git(repo, "git rev-parse HEAD");
    writeFileSync(join(repo, "AGENTS.md"), "main-change\n");
    git(repo, "git add AGENTS.md && git commit -m 'main hot change'");

    git(repo, `git checkout -b fusion/fn-4958-test ${base}`);
    writeFileSync(join(repo, "feature.txt"), "feature\n");
    git(repo, "git add feature.txt && git commit -m 'feature'");

    const mainHead = git(repo, "git rev-parse main");
    const divergence = await probeDivergence({ rootDir: repo, baseCommitSha: base, mainRef: mainHead });
    const decision = decideAutoPrerebase({
      settings: { prerebaseAutoEnabled: true, prerebaseHotFiles: ["AGENTS.md"], prerebaseDivergenceThreshold: 50 } as any,
      baseCommitSha: base,
      commitsBehind: divergence.commitsBehind,
      changedFiles: divergence.changedFiles,
      worktrunkEnabled: false,
    });
    expect(decision.reason).toBe("hot-file");

    const result = await runAutoPrerebase({ rootDir: repo, worktreePath: repo, branch: "fusion/fn-4958-test", taskId: "FN-4958", mainHead, logger: { log: vi.fn(), warn: vi.fn() } });
    expect(result.ok).toBe(true);
  });

  it("B/C/E: threshold + no-divergence + worktrunk-deferred decisions", async () => {
    const decisionThreshold = decideAutoPrerebase({
      settings: { prerebaseAutoEnabled: true, prerebaseHotFiles: [], prerebaseDivergenceThreshold: 2 } as any,
      baseCommitSha: "abc",
      commitsBehind: 3,
      changedFiles: ["x.ts"],
      worktrunkEnabled: false,
    });
    expect(decisionThreshold.reason).toBe("divergence-threshold");

    const decisionNoDiv = decideAutoPrerebase({
      settings: { prerebaseAutoEnabled: true, prerebaseHotFiles: [], prerebaseDivergenceThreshold: 10 } as any,
      baseCommitSha: "abc",
      commitsBehind: 0,
      changedFiles: [],
      worktrunkEnabled: false,
    });
    expect(decisionNoDiv.reason).toBe("no-divergence");

    const decisionWorktrunk = decideAutoPrerebase({
      settings: { prerebaseAutoEnabled: true, prerebaseHotFiles: ["AGENTS.md"], prerebaseDivergenceThreshold: 1 } as any,
      baseCommitSha: "abc",
      commitsBehind: 99,
      changedFiles: ["AGENTS.md"],
      worktrunkEnabled: true,
    });
    expect(decisionWorktrunk.reason).toBe("worktrunk-deferred");
  });
});
