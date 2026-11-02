/*
FNXC:ReviewInputProof 2026-11-02-15:52:
RUFU-445 real-git coverage for the review/merge DIFF BASE, the invariant that a base is always the
INTEGRATION fork point and never whichever ref happens to be older.

Reported reproduction (RUFU-281, in-review since 2026-09-23, mandatory `code-review` gate never
dispatched): the card had no stored `baseCommitSha`, its worktree's local `main` was 709 commits
ahead of `origin/main`, and the origin-first `resolveDiffBaseRef` chain computed a base 628 commits
behind the card's own fork point. The reviewer's "input" therefore measured 628 commits of
unpublished `main` history (38 867 308 B of `git diff --binary`, overflowing the 10 MiB capture
buffer) instead of the card's 9 commits (112 781 B), and every attempt refused with
`review-input-unprovable`.

Why real git: a string-matched `exec` mock cannot distinguish ordering inside a shell `||` chain nor
the descendant comparison — see
docs/solutions/logic-errors/files-changed-inflated-by-origin-first-base-commit.md ("Real-git test
pattern"). Assertions are structural (SHAs and enum/kind fields), never message prose.
*/
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDiffBaseRef } from "../executor/worktree-git-refs.js";
import { captureModifiedFiles } from "../executor/worktree-capture-modified-files.js";
import {
  REVIEW_DIFF_GIT_MAX_BUFFER_BYTES,
  resolveContentReviewInputProof,
} from "../worktree/review-diff-fingerprint.js";

const hasGit = (() => {
  try {
    execSync("git --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Real byte size of the patch a review proof would have to hash from `baseRef` to HEAD. */
function patchByteSize(repo: string, baseRef: string): number {
  // Bounded generously here on purpose: this assertion measures that a size EXCEEDS the production
  // budget, so the measuring tool must not impose its own smaller cap.
  return execSync(`git diff --binary '${baseRef}..HEAD'`, { cwd: repo, maxBuffer: 256 * 1024 * 1024 }).byteLength;
}

describeIfGit("resolveDiffBaseRef real-git base ordering (RUFU-445)", { timeout: 120_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tmp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  /** Bare remote whose `main` holds exactly the seeded commits pushed to it. */
  function fixture(options: { localMainCommits?: number; pushedMainCommits?: number; localMainLargeFileBytes?: number } = {}): {
    origin: string;
    clone: string;
    /** merge-base of HEAD and `origin/main` (the origin-first answer, kept for contrast asserts). */
    originMergeBase: string;
    /** merge-base of HEAD and local `main` (the integration answer). */
    localMergeBase: string;
  } {
    const origin = tmp("rufu-445-origin-");
    git(origin, "git init -q --bare -b main .");

    const clone = tmp("rufu-445-clone-");
    git(clone, `git clone ${JSON.stringify(origin)} .`);
    git(clone, 'git config user.email "test@example.com"');
    git(clone, 'git config user.name "RUFU-445 Fixture"');

    writeFileSync(join(clone, "seed.txt"), "seed\n");
    git(clone, "git add seed.txt && git commit -qm 'seed: initial commit'");
    git(clone, "git push -q origin main");

    // Commits that exist ONLY on the remote-tracking ref after the push below.
    for (let i = 0; i < (options.pushedMainCommits ?? 0); i += 1) {
      writeFileSync(join(clone, `pushed-${String(i)}.txt`), `pushed ${String(i)}\n`);
      git(clone, `git add pushed-${String(i)}.txt && git commit -qm "seed: pushed commit ${String(i)}"`);
    }
    git(clone, "git push -q origin main");

    // Commits on LOCAL main that are deliberately never pushed — this repo's normal state,
    // because the merger lands tasks on local main and AGENTS.md forbids pushing unsolicited.
    for (let i = 0; i < (options.localMainCommits ?? 0); i += 1) {
      if (i === 0 && options.localMainLargeFileBytes) {
        // A predecessor's large merged work that exists only on local main — the RUFU-281 inflation
        // source: an origin-first base has to carry it, the integration base must not.
        writeFileSync(join(clone, "history.bin"), randomBytes(options.localMainLargeFileBytes));
        git(clone, "git add history.bin && git commit -qm 'feat(FN-OTHER): large unpushed main work'");
        continue;
      }
      writeFileSync(join(clone, `unpushed-${String(i)}.txt`), `unpushed ${String(i)}\n`);
      git(clone, `git add unpushed-${String(i)}.txt && git commit -qm "feat(FN-OTHER): unpushed main work ${String(i)}"`);
    }

    const originMergeBase = git(clone, "git merge-base HEAD origin/main");
    const localMergeBase = git(clone, "git merge-base HEAD main");

    // Task branch forked from local main with its own commit (prepareForTask shape), and NO
    // stored baseCommitSha — the RUFU-281 shape.
    git(clone, "git checkout -q -B fusion/rufu-445-test main");
    writeFileSync(join(clone, "own.ts"), "export const own = 1;\n");
    git(clone, "git add own.ts && git commit -qm 'feat(RUFU-445): own task change'");

    return { origin, clone, originMergeBase, localMergeBase };
  }

  it("resolves the LOCAL integration merge-base when local main is ahead of origin/main", async () => {
    // The RUFU-281 class: local main ahead, no stored base. The origin-first chain returned the
    // stale origin merge-base; the descendant rule must return the local fork point.
    const { clone, originMergeBase, localMergeBase } = fixture({ localMainCommits: 3 });
    expect(originMergeBase).not.toBe(localMergeBase);

    await expect(resolveDiffBaseRef(clone, undefined)).resolves.toBe(localMergeBase);
  });

  it("resolves the REMOTE-tracking merge-base when origin/main is ahead of a rewound local main", async () => {
    // Mirror of resolveCapturedBaseCommitSha's RUFU-217 descendant case: after a rebase onto the
    // remote-tracking ref, that ref is the truth and the base must not rewind to local main.
    const { clone } = fixture({ pushedMainCommits: 2 });
    const originTip = git(clone, "git rev-parse origin/main");

    // Rewind local main behind origin/main, then fork the branch off the remote-tracking ref —
    // exactly the post-`rebaseNewWorktreeOntoRemote` shape.
    git(clone, "git checkout -q main");
    git(clone, "git reset -q --hard HEAD~2");
    git(clone, "git checkout -q -B fusion/rufu-445-remote main");
    git(clone, "git rebase -q origin/main");
    const staleLocalMergeBase = git(clone, "git merge-base HEAD main");

    await expect(resolveDiffBaseRef(clone, undefined)).resolves.toBe(originTip);
    expect(originTip).not.toBe(staleLocalMergeBase);
  });

  it("prefers a stored baseCommitSha and never re-derives it", async () => {
    const { clone } = fixture({ localMainCommits: 1 });
    await expect(resolveDiffBaseRef(clone, "stored-base-sha")).resolves.toBe("stored-base-sha");
  });

  it("keeps the HEAD~1 / undefined terminal fallback when neither main nor origin/main resolves", async () => {
    // Different from resolveCapturedBaseCommitSha's `git rev-parse HEAD` fallback on purpose:
    // callers branch on a falsy base, so this contract must survive the shared-helper extraction.
    const repo = tmp("rufu-445-nomain-");
    git(repo, "git init -q -b trunk");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "RUFU-445 Fixture"');
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "git add a.txt && git commit -qm 'one'");
    writeFileSync(join(repo, "a.txt"), "two\n");
    git(repo, "git add a.txt && git commit -qm 'two'");

    const firstCommit = git(repo, "git rev-parse HEAD~1");
    await expect(resolveDiffBaseRef(repo, undefined)).resolves.toBe(firstCommit);

    // Single-commit repository: HEAD~1 is unresolvable, so the contract is an honest undefined.
    const single = tmp("rufu-445-single-");
    git(single, "git init -q -b trunk");
    git(single, 'git config user.email "test@example.com"');
    git(single, 'git config user.name "RUFU-445 Fixture"');
    writeFileSync(join(single, "a.txt"), "one\n");
    git(single, "git add a.txt && git commit -qm 'one'");
    await expect(resolveDiffBaseRef(single, undefined)).resolves.toBeUndefined();
  });

  it("proves review input where the origin-first base would overflow the patch budget", async () => {
    /*
    FNXC:ReviewInputProof 2026-11-02-15:52 (RUFU-445 symptom verification 1): the reported refusal was
    `Code review cannot verify its input against base <sha>: git-diff-too-large` on a card whose work
    merged clean. The control is MEASURED here, not asserted away: the origin-first base really does
    produce a patch past the ten-megabyte budget, the corrected integration base really is a
    normal-sized patch, and the proof resolves to a fingerprint instead of a refusal.
    */
    const { clone, originMergeBase } = fixture({ localMainCommits: 1, localMainLargeFileBytes: 12 * 1024 * 1024 });
    expect(patchByteSize(clone, originMergeBase)).toBeGreaterThan(REVIEW_DIFF_GIT_MAX_BUFFER_BYTES);

    const baseRef = await resolveDiffBaseRef(clone, undefined);
    expect(baseRef, "the base must be the integration fork point").toBeTruthy();
    expect(patchByteSize(clone, String(baseRef))).toBeLessThan(64 * 1024);

    await expect(resolveContentReviewInputProof(clone, undefined)).resolves.toMatchObject({
      kind: "fingerprint",
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("scopes modified-file capture to the task and excludes unpushed local-main predecessors (FN-5937)", async () => {
    const { clone, originMergeBase } = fixture({ localMainCommits: 2 });

    // Control proving the fixture genuinely carries the drift the base choice protects against:
    // measured from the origin-first base, a predecessor's file lands in this task's raw diff.
    const staleScope = git(clone, `git diff --name-only ${originMergeBase}..HEAD`).split("\n").filter(Boolean);
    expect(staleScope.some((file) => file.includes("unpushed-"))).toBe(true);

    const baseRef = await resolveDiffBaseRef(clone, undefined);
    expect(baseRef, "the scope must be measured from the integration fork point").toBeTruthy();
    const correctScope = git(clone, `git diff --name-only ${String(baseRef)}..HEAD`).split("\n").filter(Boolean);
    expect(correctScope).toEqual(["own.ts"]);

    // And through the real capture seam: no predecessor file reaches task.modifiedFiles.
    await expect(captureModifiedFiles(clone, undefined, "RUFU-445")).resolves.toEqual(["own.ts"]);
  });
});
