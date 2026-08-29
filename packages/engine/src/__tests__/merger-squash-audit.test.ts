import { afterEach, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSquashMerge } from "../merge/merger-squash-audit.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function write(repo: string, relativePath: string, content: string): void {
  writeFileSync(join(repo, relativePath), content, "utf-8");
}

describeIfGit("auditSquashMerge", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  function setupRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "fusion-merger-squash-audit-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    write(repo, "README.md", "init\n");
    git(repo, "git add README.md && git commit -m 'init'");
    return repo;
  }

  function createSquashCommit(repo: string, bodyLines: string[]): string {
    const body = bodyLines.map((line) => `- ${line}`).join("\n");
    git(repo, `git commit -m ${JSON.stringify("feat: squash merge")} -m ${JSON.stringify(body)}`);
    return git(repo, "git rev-parse HEAD");
  }

  it("returns a clean result when no duplicate subjects or recent-main file overlaps exist", async () => {
    const repo = setupRepo();

    git(repo, "git checkout -b feature/clean");
    write(repo, "feature.txt", "branch-only\n");
    git(repo, "git add feature.txt && git commit -m 'feat: branch clean change'");

    git(repo, "git checkout main");
    write(repo, "main-only.txt", "recent main\n");
    git(repo, "git add main-only.txt && git commit -m 'chore: recent main touch'");

    git(repo, "git merge --squash feature/clean");
    const squashSha = createSquashCommit(repo, ["feat: branch clean change"]);

    const findings = await auditSquashMerge({ rootDir: repo, squashSha, lookback: 10 });

    expect(findings.clean).toBe(true);
    expect(findings.issueCount).toBe(0);
    expect(findings.duplicateSubjects).toEqual([]);
    expect(findings.touchedFileOverlaps).toEqual([]);
  });

  it("reports duplicate branch subjects that match recent main commits", async () => {
    const repo = setupRepo();

    git(repo, "git checkout -b feature/dupe");
    write(repo, "branch.txt", "feature\n");
    git(repo, "git add branch.txt && git commit -m 'feat: duplicate subject'");

    git(repo, "git checkout main");
    write(repo, "main.txt", "main\n");
    git(repo, "git add main.txt && git commit -m 'feat: duplicate subject'");

    git(repo, "git merge --squash feature/dupe");
    const squashSha = createSquashCommit(repo, ["feat: duplicate subject"]);

    const findings = await auditSquashMerge({ rootDir: repo, squashSha, lookback: 10 });

    expect(findings.clean).toBe(false);
    expect(findings.duplicateSubjects).toEqual([
      { type: "duplicate-subject", subject: "feat: duplicate subject" },
    ]);
    expect(findings.issueCount).toBe(1);
  });

  it("reports touched-file overlaps with recent main commits", async () => {
    const repo = setupRepo();

    write(repo, "shared.txt", "alpha\nbeta\ngamma\n");
    git(repo, "git add shared.txt && git commit -m 'chore: add shared file'");

    git(repo, "git checkout -b feature/overlap");
    write(repo, "shared.txt", "alpha-branch\nbeta\ngamma\n");
    git(repo, "git add shared.txt && git commit -m 'feat: branch edits shared file'");

    git(repo, "git checkout main");
    write(repo, "shared.txt", "alpha\nbeta\ngamma-main\n");
    git(repo, "git add shared.txt && git commit -m 'fix: main edits shared file'");

    git(repo, "git merge --squash feature/overlap");
    const squashSha = createSquashCommit(repo, ["feat: branch edits shared file"]);

    const findings = await auditSquashMerge({ rootDir: repo, squashSha, lookback: 10 });

    expect(findings.clean).toBe(false);
    expect(findings.duplicateSubjects).toEqual([]);
    expect(findings.touchedFileOverlaps).toHaveLength(1);
    expect(findings.touchedFileOverlaps[0]).toMatchObject({
      type: "touched-file-overlap",
      file: "shared.txt",
    });
    expect(findings.touchedFileOverlaps[0].recentMainCommits).toEqual(
      expect.arrayContaining([
        {
          sha: expect.any(String),
          subject: "fix: main edits shared file",
        },
      ]),
    );
    expect(findings.issueCount).toBe(1);
  });

  it("reports combined duplicate-subject and touched-file overlap findings", async () => {
    const repo = setupRepo();

    write(repo, "shared.txt", "alpha\nbeta\ngamma\n");
    git(repo, "git add shared.txt && git commit -m 'chore: add shared file'");

    git(repo, "git checkout -b feature/combined");
    write(repo, "shared.txt", "alpha-branch\nbeta\ngamma\n");
    git(repo, "git add shared.txt && git commit -m 'feat: duplicate and overlap'");

    git(repo, "git checkout main");
    write(repo, "shared.txt", "alpha\nbeta\ngamma-main\n");
    git(repo, "git add shared.txt && git commit -m 'feat: duplicate and overlap'");

    git(repo, "git merge --squash feature/combined");
    const squashSha = createSquashCommit(repo, ["feat: duplicate and overlap"]);

    const findings = await auditSquashMerge({ rootDir: repo, squashSha, lookback: 10 });

    expect(findings.clean).toBe(false);
    expect(findings.issueCount).toBe(2);
    expect(findings.duplicateSubjects).toEqual([
      { type: "duplicate-subject", subject: "feat: duplicate and overlap" },
    ]);
    expect(findings.touchedFileOverlaps).toHaveLength(1);
    expect(findings.touchedFileOverlaps[0]).toMatchObject({
      type: "touched-file-overlap",
      file: "shared.txt",
    });
  });

  it("rebase strategy audits overlap across all commits in a multi-commit range", async () => {
    const repo = setupRepo();

    write(repo, "shared-a.txt", "a0\n");
    write(repo, "shared-b.txt", "b0\n");
    git(repo, "git add shared-a.txt shared-b.txt && git commit -m 'chore: seed shared files'");

    git(repo, "git checkout -b feature/multi-range");
    write(repo, "shared-a.txt", "a0\nfeature-a\n");
    git(repo, "git add shared-a.txt && git commit -m 'feat: branch overlap a'");
    write(repo, "shared-b.txt", "b0\nfeature-b\n");
    git(repo, "git add shared-b.txt && git commit -m 'feat: branch overlap b'");
    const rangeHeadSha = git(repo, "git rev-parse HEAD");

    git(repo, "git checkout main");
    write(repo, "shared-a.txt", "a0\nmain-a\n");
    git(repo, "git add shared-a.txt && git commit -m 'feat: branch overlap a'");
    write(repo, "shared-b.txt", "b0\nmain-b\n");
    git(repo, "git add shared-b.txt && git commit -m 'feat: branch overlap b'");

    const rangeBaseSha = git(repo, "git merge-base feature/multi-range main");
    const findings = await auditSquashMerge({
      rootDir: repo,
      strategy: "rebase",
      rangeBaseSha,
      rangeHeadSha,
      lookback: 20,
    });

    expect(findings.clean).toBe(false);
    expect(findings.touchedFileOverlaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "shared-a.txt" }),
      expect.objectContaining({ file: "shared-b.txt" }),
    ]));
  });

  it("single-commit squash fallback on the same multi-commit branch only sees tip subject", async () => {
    const repo = setupRepo();

    write(repo, "shared-a.txt", "a0\n");
    write(repo, "shared-b.txt", "b0\n");
    git(repo, "git add shared-a.txt shared-b.txt && git commit -m 'chore: seed shared files'");

    git(repo, "git checkout -b feature/multi-fallback");
    write(repo, "shared-a.txt", "a0\nfeature-a\n");
    git(repo, "git add shared-a.txt && git commit -m 'feat: branch overlap a'");
    write(repo, "shared-b.txt", "b0\nfeature-b\n");
    git(repo, "git add shared-b.txt && git commit -m 'feat: branch overlap b'");

    git(repo, "git checkout main");
    write(repo, "shared-a.txt", "a0\nmain-a\n");
    git(repo, "git add shared-a.txt && git commit -m 'feat: branch overlap a'");
    write(repo, "shared-b.txt", "b0\nmain-b\n");
    git(repo, "git add shared-b.txt && git commit -m 'feat: branch overlap b'");

    write(repo, "shared-b.txt", "b0\nmain-b\nfinal\n");
    git(repo, "git add shared-b.txt && git commit -m 'feat: squash merge' -m '- feat: branch overlap b'");
    const squashSha = git(repo, "git rev-parse HEAD");

    const findings = await auditSquashMerge({ rootDir: repo, strategy: "squash", squashSha, lookback: 20 });

    expect(findings.duplicateSubjects).toEqual([{ type: "duplicate-subject", subject: "feat: branch overlap b" }]);
    expect(findings.duplicateSubjects).not.toContainEqual({ type: "duplicate-subject", subject: "feat: branch overlap a" });
  });
});
