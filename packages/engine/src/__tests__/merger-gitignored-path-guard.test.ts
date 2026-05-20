import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { commitOrAmendMergeWithFixes, filterStagedGitignoredPaths } from "../merger.js";
import { mergerLog } from "../logger.js";
import { DEFAULT_SETTINGS } from "@fusion/core";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

function initRepo(dir: string): void {
  git(dir, "git init -b main");
  git(dir, 'git config user.email "test@example.com"');
  git(dir, 'git config user.name "Test"');
  writeFileSync(join(dir, ".gitignore"), ".fusion/\nnode_modules/\n");
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, "git add .gitignore README.md");
  git(dir, 'git commit -m "chore: init"');
}

const created = new Set<string>();
afterEach(() => {
  try {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.clear();
  } finally {
    vi.restoreAllMocks();
  }
});

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-test-gitignored-"));
  created.add(dir);
  initRepo(dir);
  return dir;
}

describe("filterStagedGitignoredPaths", () => {
  it("unstages forced .fusion task artifacts", async () => {
    const dir = mkRepo();
    mkdirSync(join(dir, ".fusion/tasks/FN-1"), { recursive: true });
    writeFileSync(join(dir, ".fusion/tasks/FN-1/note.md"), "note\n");
    git(dir, "git add -f -- .fusion/tasks/FN-1/note.md");

    const result = await filterStagedGitignoredPaths(dir, "FN-4309");
    expect(result).toEqual({ unstaged: [".fusion/tasks/FN-1/note.md"], remainingStaged: 0 });
  });

  it("unstages gitignored paths including spaces and keeps clean paths staged", async () => {
    const dir = mkRepo();
    const warnSpy = vi.spyOn(mergerLog, "warn").mockImplementation(() => undefined);

    mkdirSync(join(dir, ".fusion/tasks/FN-1"), { recursive: true });
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, ".fusion/tasks/FN-1/a b.md"), "note\n");
    writeFileSync(join(dir, "node_modules/foo.js"), "module.exports = 1;\n");
    writeFileSync(join(dir, "kept.txt"), "keep\n");

    git(dir, 'git add -f -- ".fusion/tasks/FN-1/a b.md" node_modules/foo.js kept.txt');

    const result = await filterStagedGitignoredPaths(dir, "FN-4309");
    expect(result.unstaged.sort()).toEqual([".fusion/tasks/FN-1/a b.md", "node_modules/foo.js"]);
    expect(result.remainingStaged).toBe(1);
    expect(git(dir, "git diff --cached --name-only").trim()).toBe("kept.txt");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('refusing to stage gitignored path ".fusion/tasks/FN-1/a b.md"'));

    const second = await filterStagedGitignoredPaths(dir, "FN-4309");
    expect(second).toEqual({ unstaged: [], remainingStaged: 1 });
  });

  it("returns empty result with empty index", async () => {
    const dir = mkRepo();
    await expect(filterStagedGitignoredPaths(dir, "FN-4309")).resolves.toEqual({ unstaged: [], remainingStaged: 0 });
  });
});

describe("commitOrAmendMergeWithFixes gitignored guard", () => {
  it("strips already-committed .fusion path from squash and returns no-content when all staged files are ignored", async () => {
    const dir = mkRepo();
    const preAttemptHeadSha = git(dir, "git rev-parse HEAD");

    git(dir, "git checkout -b feat/ignored");
    mkdirSync(join(dir, ".fusion/tasks/FN-X"), { recursive: true });
    writeFileSync(join(dir, ".fusion/tasks/FN-X/findings.md"), "findings\n");
    git(dir, 'git add -f -- .fusion/tasks/FN-X/findings.md');
    git(dir, 'git commit -m "feat: ignored artifact"');
    git(dir, "git checkout main");
    git(dir, "git merge --squash feat/ignored");

    const result = await commitOrAmendMergeWithFixes(
      dir,
      "FN-4309",
      "feat/ignored",
      "feat(FN-4309): test",
      true,
      preAttemptHeadSha,
      "",
      undefined,
      { ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, commitAuthorEnabled: false },
      undefined,
      null,
      null,
      new Set(),
    );

    expect(result).toEqual({ ok: false, reason: "fix-produced-no-content" });
    expect(git(dir, "git diff --cached --name-only").trim()).toBe("");
  });
});
