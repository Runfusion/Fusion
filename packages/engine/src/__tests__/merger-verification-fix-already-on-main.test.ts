import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { commitOrAmendMergeWithFixes } from "../merger.js";
import { DEFAULT_SETTINGS } from "@fusion/core";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

function testTempParent(): string {
  return process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
}

const created = new Set<string>();
afterEach(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.clear();
});

function mkRepo(): string {
  const dir = mkdtempSync(join(testTempParent(), "fusion-test-merge-already-on-main-"));
  created.add(dir);
  git(dir, "git init -b main");
  git(dir, 'git config user.email "test@example.com"');
  git(dir, 'git config user.name "Test"');
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, "git add README.md");
  git(dir, 'git commit -m "chore: init"');
  return dir;
}

describe("commitOrAmendMergeWithFixes already-on-main recovery", () => {
  it("returns branch-already-merged-on-main when task trailer exists on main but branch tip is misbound", async () => {
    const dir = mkRepo();

    writeFileSync(join(dir, "README.md"), "other\n");
    git(dir, "git add README.md");
    git(dir, 'git commit -m "feat(FN-4545): unrelated"');
    const unrelatedSha = git(dir, "git rev-parse HEAD");

    writeFileSync(join(dir, "task-file.txt"), "task content\n");
    git(dir, "git add task-file.txt");
    git(
      dir,
      'git commit -m "feat(FN-4553): landed task" -m "Fusion-Task-Id: FN-4553" -m "Fusion-Task-Lineage: lineage-4553"',
    );
    const landedSha = git(dir, "git rev-parse HEAD");

    writeFileSync(join(dir, "post.txt"), "post\n");
    git(dir, "git add post.txt");
    git(dir, 'git commit -m "chore: post-landing commit"');
    const preAttemptHeadSha = git(dir, "git rev-parse HEAD");

    git(dir, `git branch fusion/fn-4553 ${unrelatedSha}`);

    const result = await commitOrAmendMergeWithFixes(
      dir,
      "FN-4553",
      "fusion/fn-4553",
      "feat(FN-4553): finalize",
      true,
      preAttemptHeadSha,
      "",
      undefined,
      { ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, commitAuthorEnabled: false },
      undefined,
      null,
      null,
      null,
      new Set(),
    );

    expect(result).toEqual({
      ok: true,
      reason: "branch-already-merged-on-main",
      mergeSha: landedSha,
      strategy: "trailer",
    });
    expect(git(dir, "git rev-parse HEAD")).toBe(preAttemptHeadSha);
  }, 20_000);
});
