import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  advanceIntegrationBranchRef,
  assertLandingTargetHealthy,
  listIntegrationBranchWorktrees,
  rewindBranchRef,
  rewriteCheckedOutRefBackwards,
} from "../merge/merger-ref-update-advance.js";
import { autoRecoverCrossContamination } from "../execution/branch-conflicts.js";

// Real-git suite for the STAS-292 landing contract: a landing must move ref,
// index and working tree as one unit inside the worktree that owns the
// integration branch, and must fail loud — never leave a ref ahead of its
// checkout — when that worktree's index does not match HEAD.
//
// Repos live under tracked tmp dirs and are swept on exit as well as in
// `finally`, because vitest's forks pool SIGTERMs a fork on timeout and skips
// the finally block (scripts/check-test-isolation.mjs then fails merge
// verification on the leaked dirs).
const TMP_DIR_RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const TMP_DIR_CLEANUP_HOOK_KEY = Symbol.for(
  "fusion.engine.merger-landing-worktree-advance-test.tmp-cleanup-hooks-installed",
);
const trackedTmpDirs = new Set<string>();

function removeTmpDirSync(dir: string): void {
  try {
    rmSync(dir, TMP_DIR_RM_OPTIONS);
  } catch {
    // best-effort fallback during teardown
  } finally {
    trackedTmpDirs.delete(dir);
  }
}

function cleanupTmpDirsSync(): void {
  for (const dir of Array.from(trackedTmpDirs)) removeTmpDirSync(dir);
}

const processWithCleanupFlag = process as typeof process & {
  [TMP_DIR_CLEANUP_HOOK_KEY]?: boolean;
};
if (!processWithCleanupFlag[TMP_DIR_CLEANUP_HOOK_KEY]) {
  process.once("beforeExit", cleanupTmpDirsSync);
  process.once("exit", cleanupTmpDirsSync);
  processWithCleanupFlag[TMP_DIR_CLEANUP_HOOK_KEY] = true;
}

afterAll(() => {
  cleanupTmpDirsSync();
});

function git(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

interface AuditEvent {
  type: string;
  target?: string;
  metadata?: Record<string, unknown>;
}

interface CapturedAudit {
  git: (event: AuditEvent) => Promise<void>;
  events: AuditEvent[];
}

function makeQuietAudit(): CapturedAudit {
  const events: AuditEvent[] = [];
  return {
    events,
    git: async (event: AuditEvent) => {
      events.push(event);
    },
  };
}

/**
 * Landscape mirroring production: `trunk` is the user's checkout of the
 * integration branch, `landing` is the engine's task worktree whose branch
 * carries the squash commit. The advance's `rootDir` is the landing worktree —
 * precisely why the old blind `update-ref` could move `main` without ever
 * touching `trunk`.
 */
function setupLandscape(): {
  root: string;
  trunk: string;
  landing: string;
  newSha: string;
  expectedCurrentSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), "fusion-test-landing-guard-"));
  trackedTmpDirs.add(root);
  const trunk = join(root, "trunk");
  const landing = join(root, "landing");
  execSync(`git init -b main "${trunk}"`, { stdio: "pipe" });
  git(trunk, "git config user.name tester");
  git(trunk, "git config user.email tester@example.com");
  writeFileSync(join(trunk, "tracked.txt"), "one\n");
  git(trunk, "git add tracked.txt");
  git(trunk, "git commit -m init");
  writeFileSync(join(trunk, "second.txt"), "two\n");
  git(trunk, "git add second.txt");
  git(trunk, "git commit -m second");

  git(trunk, `git worktree add -b fusion/task-1 ${JSON.stringify(landing)} main`);
  git(landing, "git config user.name tester");
  git(landing, "git config user.email tester@example.com");
  writeFileSync(join(landing, "landed.txt"), "landed\n");
  git(landing, "git add landed.txt");
  git(landing, "git commit -m squash");

  return {
    root,
    trunk,
    landing,
    newSha: git(landing, "git rev-parse HEAD"),
    expectedCurrentSha: git(trunk, "git rev-parse refs/heads/main"),
  };
}

async function runAdvance(args: {
  rootDir: string;
  integrationBranch?: string;
  newSha: string;
  expectedCurrentSha: string;
  allowNonFastForward?: boolean;
  audit?: CapturedAudit;
}) {
  const audit = args.audit ?? makeQuietAudit();
  const result = await advanceIntegrationBranchRef({
    rootDir: args.rootDir,
    integrationBranch: args.integrationBranch ?? "main",
    newSha: args.newSha,
    expectedCurrentSha: args.expectedCurrentSha,
    taskId: "STAS-292",
    audit: audit as never,
    allowNonFastForward: args.allowNonFastForward,
  });
  return { result, audit };
}

async function captureRejection(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => {
      throw new Error("expected the landing to be refused, but it advanced");
    },
    (error: unknown) => String(error),
  );
}

describe("landing advances ref, index and working tree as one unit", () => {
  it("fast-forwards the owning worktree instead of only moving the ref", async () => {
    const fx = setupLandscape();
    const audit = makeQuietAudit();
    try {
      await runAdvance({
        rootDir: fx.landing,
        newSha: fx.newSha,
        expectedCurrentSha: fx.expectedCurrentSha,
        audit,
      });

      expect(git(fx.trunk, "git rev-parse HEAD")).toBe(fx.newSha);
      expect(git(fx.trunk, "git write-tree")).toBe(git(fx.trunk, "git rev-parse HEAD^{tree}"));
      expect(git(fx.trunk, "git diff --cached HEAD --name-only")).toBe("");
      expect(git(fx.trunk, "git status --porcelain")).toBe("");
      expect(existsSync(join(fx.trunk, "landed.txt"))).toBe(true);
      expect(audit.events.at(-1)?.metadata?.advanceMode).toBe("merge-ff-only");
      expect(audit.events.at(-1)?.metadata?.worktreePath).toBe(fx.trunk);
    } finally {
      removeTmpDirSync(fx.root);
    }
  });

  it("keeps an uncommitted edit the landing does not touch", async () => {
    const fx = setupLandscape();
    try {
      writeFileSync(join(fx.trunk, "second.txt"), "two\nlocal edit\n");
      writeFileSync(join(fx.trunk, "local-notes.txt"), "keep me\n");

      await runAdvance({
        rootDir: fx.landing,
        newSha: fx.newSha,
        expectedCurrentSha: fx.expectedCurrentSha,
      });

      expect(git(fx.trunk, "git rev-parse HEAD")).toBe(fx.newSha);
      expect(readFileSync(join(fx.trunk, "second.txt"), "utf-8")).toBe("two\nlocal edit\n");
      expect(git(fx.trunk, "git diff --cached --name-only")).toBe("");
      expect(git(fx.trunk, "git status --porcelain")).toContain("second.txt");
      expect(existsSync(join(fx.trunk, "landed.txt"))).toBe(true);
    } finally {
      removeTmpDirSync(fx.root);
    }
  });

  it("names the reflog entry when the branch is checked out nowhere", async () => {
    const fx = setupLandscape();
    try {
      git(fx.trunk, "git checkout --detach");

      await runAdvance({
        rootDir: fx.landing,
        newSha: fx.newSha,
        expectedCurrentSha: fx.expectedCurrentSha,
      });

      const firstReflogSubject = git(fx.trunk, "git log -g refs/heads/main --format=%gs").split("\n")[0];
      expect(firstReflogSubject).toContain("fusion landing");
      expect(firstReflogSubject).toContain("STAS-292");
    } finally {
      removeTmpDirSync(fx.root);
    }
  });

  it("treats a prunable worktree registration as no owner", async () => {
    const fx = setupLandscape();
    try {
      const stale = join(fx.root, "stale-owner");
      git(fx.trunk, "git checkout --detach");
      git(fx.trunk, `git worktree add ${JSON.stringify(stale)} main`);
      rmSync(stale, { recursive: true, force: true });

      await runAdvance({
        rootDir: fx.landing,
        newSha: fx.newSha,
        expectedCurrentSha: fx.expectedCurrentSha,
      });

      expect(git(fx.trunk, "git rev-parse refs/heads/main")).toBe(fx.newSha);
    } finally {
      removeTmpDirSync(fx.root);
    }
  });
});

describe("landing refuses rather than leaving a ref ahead of its checkout", () => {
  it("refuses when the owning worktree index does not match HEAD, ref unmoved", async () => {
    const fx = setupLandscape();
    try {
      // The STAS-101/STAS-124 state: the index records the inverse of a
      // landing while the working tree is untouched, so `git status` shows a
      // staged deletion and `write-tree` differs from `HEAD^{tree}`.
      git(fx.trunk, "git rm --cached tracked.txt");

      const message = await captureRejection(
        runAdvance({
          rootDir: fx.landing,
          newSha: fx.newSha,
          expectedCurrentSha: fx.expectedCurrentSha,
        }),
      );

      expect(message).toContain("landing refused:");
      expect(message).toContain("index does not match HEAD");
      expect(message).toContain(fx.trunk);
      expect(message).toContain("tracked.txt");
      expect(message).toContain("expected tree");
      expect(message).toContain("actual index tree (write-tree)");
      expect(message).toContain("git restore --source=HEAD --staged --worktree");

      expect(git(fx.trunk, "git rev-parse refs/heads/main")).toBe(fx.expectedCurrentSha);
      expect(git(fx.trunk, "git rev-parse HEAD")).toBe(fx.expectedCurrentSha);
      expect(existsSync(join(fx.trunk, "landed.txt"))).toBe(false);
    } finally {
      removeTmpDirSync(fx.root);
    }
  });

  it("refuses a colliding uncommitted edit without reaching for a stash", async () => {
    const fx = setupLandscape();
    try {
      // The squash modifies a file the user also edited locally: the index
      // still matches HEAD, so only `merge --ff-only` can catch this.
      git(fx.landing, "git checkout fusion/task-1");
      writeFileSync(join(fx.landing, "second.txt"), "two\nlanded rewrite\n");
      git(fx.landing, "git add second.txt");
      git(fx.landing, "git commit -m 'squash touches second.txt'");
      writeFileSync(join(fx.trunk, "second.txt"), "two\nlocal edit\n");
      const trunkHead = git(fx.trunk, "git rev-parse HEAD");

      const message = await captureRejection(
        runAdvance({
          rootDir: fx.landing,
          newSha: git(fx.landing, "git rev-parse HEAD"),
          expectedCurrentSha: fx.expectedCurrentSha,
        }),
      );

      expect(message).toContain("landing refused:");
      expect(git(fx.trunk, "git rev-parse HEAD")).toBe(trunkHead);
      expect(git(fx.trunk, "git rev-parse refs/heads/main")).toBe(trunkHead);
      expect(git(fx.trunk, "git stash list")).toBe("");
      expect(readFileSync(join(fx.trunk, "second.txt"), "utf-8")).toBe("two\nlocal edit\n");
    } finally {
      removeTmpDirSync(fx.root);
    }
  });


  it("refuses when two worktrees claim the integration branch", async () => {
    const fx = setupLandscape();
    try {
      const second = join(fx.root, "second-main");
      git(fx.trunk, `git worktree add ${JSON.stringify(second)} --detach`);
      git(second, "git checkout --ignore-other-worktrees main");

      const message = await captureRejection(
        runAdvance({
          rootDir: fx.landing,
          newSha: fx.newSha,
          expectedCurrentSha: fx.expectedCurrentSha,
        }),
      );

      expect(message).toContain("landing refused:");
      expect(git(fx.trunk, "git rev-parse refs/heads/main")).toBe(fx.expectedCurrentSha);
      expect(git(second, "git rev-parse HEAD")).toBe(fx.expectedCurrentSha);
    } finally {
      removeTmpDirSync(fx.root);
    }
  });
});

/**
 * Landscape for the push-after-merge contract. `trunk` sits on `main` at a landed
 * squash; `clean-room` is the divergence rebase — the same change replayed on top of
 * a commit the local tip has never seen. The rebased sha therefore does NOT descend
 * from the local tip, which is what makes the push path the one caller allowed to ask
 * for a non-fast-forward move.
 */
function setupRebasedLandscape(): {
  root: string;
  trunk: string;
  cleanRoom: string;
  localTip: string;
  rebasedSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), "fusion-test-landing-rebase-"));
  trackedTmpDirs.add(root);
  const trunk = join(root, "trunk");
  const cleanRoom = join(root, "clean-room");
  execSync(`git init -b main "${trunk}"`, { stdio: "pipe" });
  git(trunk, "git config user.name tester");
  git(trunk, "git config user.email tester@example.com");
  writeFileSync(join(trunk, "tracked.txt"), "one\n");
  git(trunk, "git add tracked.txt");
  git(trunk, "git commit -m init");
  const baseSha = git(trunk, "git rev-parse HEAD");

  writeFileSync(join(trunk, "landed.txt"), "landed\n");
  git(trunk, "git add landed.txt");
  git(trunk, "git commit -m 'FN-1: squash'");
  const localTip = git(trunk, "git rev-parse main");

  git(trunk, `git worktree add -b upstream ${JSON.stringify(cleanRoom)} ${baseSha}`);
  git(cleanRoom, "git config user.name tester");
  git(cleanRoom, "git config user.email tester@example.com");
  writeFileSync(join(cleanRoom, "remote.txt"), "remote\n");
  git(cleanRoom, "git add remote.txt");
  git(cleanRoom, "git commit -m 'remote: remote.txt'");
  git(cleanRoom, `git cherry-pick ${localTip}`);

  return { root, trunk, cleanRoom, localTip, rebasedSha: git(cleanRoom, "git rev-parse HEAD") };
}

describe("the non-fast-forward lane the push-after-merge rebase opts into", () => {
  it("moves a checked-out branch, its index and its files to the rebased tip", async () => {
    const fx = setupRebasedLandscape();
    const audit = makeQuietAudit();
    try {
      // Documents the fixture shape this lane exists for: the rebased sha must not
      // descend from the tip the local ref is on.
      expect(() => git(fx.trunk, `git merge-base --is-ancestor ${fx.localTip} ${fx.rebasedSha}`)).toThrow();

      const { result } = await runAdvance({
        rootDir: fx.trunk,
        newSha: fx.rebasedSha,
        expectedCurrentSha: fx.localTip,
        allowNonFastForward: true,
        audit,
      });

      expect(result.advanced).toBe(true);
      expect(git(fx.trunk, "git rev-parse HEAD")).toBe(fx.rebasedSha);
      expect(git(fx.trunk, "git rev-parse refs/heads/main")).toBe(fx.rebasedSha);
      expect(git(fx.trunk, "git write-tree")).toBe(git(fx.trunk, "git rev-parse HEAD^{tree}"));
      expect(git(fx.trunk, "git status --porcelain")).toBe("");
      expect(existsSync(join(fx.trunk, "remote.txt"))).toBe(true);
      expect(existsSync(join(fx.trunk, "landed.txt"))).toBe(true);
      const reflogSubject = git(fx.trunk, "git log -g refs/heads/main --format=%gs").split("\n")[0];
      expect(reflogSubject).toContain("fusion landing");
      expect(reflogSubject).toContain("non-fast-forward rebase");
      expect(audit.events.at(-1)?.metadata?.advanceMode).toBe("update-ref");
      expect(audit.events.at(-1)?.metadata?.worktreePath).toBe(fx.trunk);
    } finally {
      removeTmpDirSync(fx.root);
    }
  });

  it("refuses to overwrite a dirty checkout on this lane, reporting it with nothing moved", async () => {
    const fx = setupRebasedLandscape();
    const audit = makeQuietAudit();
    try {
      writeFileSync(join(fx.trunk, "tracked.txt"), "one\nlocal edit\n");

      const { result } = await runAdvance({
        rootDir: fx.trunk,
        newSha: fx.rebasedSha,
        expectedCurrentSha: fx.localTip,
        allowNonFastForward: true,
        audit,
      });

      expect(result).toEqual({
        advanced: false,
        reason: "owned-checkout-refused",
        diagnostic: expect.stringContaining("carries uncommitted work"),
        observedCurrentSha: fx.localTip,
      });
      expect(git(fx.trunk, "git rev-parse refs/heads/main")).toBe(fx.localTip);
      expect(readFileSync(join(fx.trunk, "tracked.txt"), "utf-8")).toBe("one\nlocal edit\n");
      expect(existsSync(join(fx.trunk, "remote.txt"))).toBe(false);
      expect(audit.events.at(-1)?.metadata?.succeeded).toBe(false);
    } finally {
      removeTmpDirSync(fx.root);
    }
  });

  it("cannot drop a newer commit someone else landed while the push was in flight", async () => {
    const fx = setupLandscape();
    try {
      const sibling = join(fx.root, "sibling");
      git(fx.trunk, "git checkout --detach");
      git(fx.trunk, `git worktree add ${JSON.stringify(sibling)} main`);
      writeFileSync(join(sibling, "sibling.txt"), "sibling\n");
      git(sibling, "git add sibling.txt");
      git(sibling, "git commit -m sibling");
      const siblingSha = git(sibling, "git rev-parse HEAD");

      // The push path fences with the tip it landed, not with whatever the branch
      // moved to afterwards. A third-party commit therefore loses the fence, and the
      // rewrite never runs — that commit's content stays reachable and its checkout
      // is untouched.
      const { result } = await runAdvance({
        rootDir: fx.landing,
        newSha: fx.newSha,
        expectedCurrentSha: fx.expectedCurrentSha,
        allowNonFastForward: true,
      });

      expect(result).toMatchObject({ advanced: false, reason: "concurrent-advance" });
      expect(git(sibling, "git rev-parse HEAD")).toBe(siblingSha);
      expect(git(fx.trunk, "git rev-parse refs/heads/main")).toBe(siblingSha);
      expect(existsSync(join(sibling, "sibling.txt"))).toBe(true);
    } finally {
      removeTmpDirSync(fx.root);
    }
  });
});

describe("assertLandingTargetHealthy (the pre-flight guard landSquash runs)", () => {
  it("passes a healthy checkout through and reports its owner", async () => {
    const fx = setupLandscape();
    try {
      await expect(assertLandingTargetHealthy({ rootDir: fx.landing, integrationBranch: "main" })).resolves.toEqual({
        worktreePath: fx.trunk,
      });
    } finally {
      removeTmpDirSync(fx.root);
    }
  });

  it("refuses a corrupted index naming the same repair, and measures without mutating", async () => {
    const fx = setupLandscape();
    try {
      git(fx.trunk, "git rm --cached tracked.txt");
      const before = {
        ref: git(fx.trunk, "git rev-parse refs/heads/main"),
        index: git(fx.trunk, "git write-tree"),
        status: git(fx.trunk, "git status --porcelain"),
      };

      const message = await captureRejection(assertLandingTargetHealthy({ rootDir: fx.landing, integrationBranch: "main" }));

      expect(message).toContain("index does not match HEAD");
      expect(message).toContain("tracked.txt");
      expect(message).toContain("git restore --source=HEAD --staged --worktree");
      // Read-only: a guard that "fixed" the index would be the silent reset this
      // card exists to remove, so the corrupted state must survive the call.
      expect(git(fx.trunk, "git rev-parse refs/heads/main")).toBe(before.ref);
      expect(git(fx.trunk, "git write-tree")).toBe(before.index);
      expect(git(fx.trunk, "git status --porcelain")).toBe(before.status);
    } finally {
      removeTmpDirSync(fx.root);
    }
  });

  it("says nothing about a branch that is checked out nowhere", async () => {
    const fx = setupLandscape();
    try {
      git(fx.trunk, "git checkout --detach");
      await expect(assertLandingTargetHealthy({ rootDir: fx.landing, integrationBranch: "main" })).resolves.toEqual({});
    } finally {
      removeTmpDirSync(fx.root);
    }
  });
});

describe("listIntegrationBranchWorktrees", () => {
  it("reports the owning worktree, then nothing once it is detached", async () => {
    const fx = setupLandscape();
    try {
      const owners = await listIntegrationBranchWorktrees({
        rootDir: fx.landing,
        integrationBranch: "main",
      });
      expect(owners.map((owner) => owner.path)).toEqual([fx.trunk]);

      git(fx.trunk, "git checkout --detach");
      expect(
        await listIntegrationBranchWorktrees({ rootDir: fx.landing, integrationBranch: "main" }),
      ).toEqual([]);
    } finally {
      removeTmpDirSync(fx.root);
    }
  });
});

describe("rewindBranchRef (the stas-190 class: a rewind driven from a repo root)", () => {
  it("follows the branch to the checkout that owns it instead of leaving it behind", async () => {
    const fx = setupLandscape();
    try {
      await runAdvance({
        rootDir: fx.landing,
        newSha: fx.newSha,
        expectedCurrentSha: fx.expectedCurrentSha,
      });

      // The caller only knows the repo root and the branch, exactly like the
      // CLI's PR-head rollback. The owner is `trunk`, not the caller's cwd.
      await rewindBranchRef({
        rootDir: fx.landing,
        integrationBranch: "main",
        targetSha: fx.expectedCurrentSha,
        expectedCurrentSha: fx.newSha,
        reason: "fusion pr-head rollback: STAS-292",
      });

      expect(git(fx.trunk, "git rev-parse refs/heads/main")).toBe(fx.expectedCurrentSha);
      expect(git(fx.trunk, "git rev-parse HEAD")).toBe(fx.expectedCurrentSha);
      // The invariant that the raw `update-ref` violated: the owning checkout's
      // index and files moved with the ref, so it shows no phantom revert.
      expect(git(fx.trunk, "git write-tree")).toBe(git(fx.trunk, "git rev-parse HEAD^{tree}"));
      expect(git(fx.trunk, "git status --porcelain")).toBe("");
      expect(existsSync(join(fx.trunk, "landed.txt"))).toBe(false);
    } finally {
      removeTmpDirSync(fx.root);
    }
  });

  it("names the reflog when the branch is attached to no checkout", async () => {
    const fx = setupLandscape();
    try {
      await runAdvance({
        rootDir: fx.landing,
        newSha: fx.newSha,
        expectedCurrentSha: fx.expectedCurrentSha,
      });
      git(fx.trunk, "git checkout --detach");

      await rewindBranchRef({
        rootDir: fx.landing,
        integrationBranch: "main",
        targetSha: fx.expectedCurrentSha,
        expectedCurrentSha: fx.newSha,
        reason: "fusion pr-head rollback: STAS-292",
      });

      expect(git(fx.trunk, "git rev-parse refs/heads/main")).toBe(fx.expectedCurrentSha);
      expect(git(fx.trunk, "git log -g refs/heads/main --format=%gs").split("\n")[0]).toContain(
        "fusion pr-head rollback",
      );
    } finally {
      removeTmpDirSync(fx.root);
    }
  });

  it("refuses a rewind whose CAS fence lost, leaving the ref untouched", async () => {
    const fx = setupLandscape();
    try {
      const message = await captureRejection(
        rewindBranchRef({
          rootDir: fx.landing,
          integrationBranch: "main",
          targetSha: fx.expectedCurrentSha,
          expectedCurrentSha: "0000000000000000000000000000000000000000",
          reason: "fusion pr-head rollback: STAS-292",
        }),
      );

      expect(message).toContain("refused");
      expect(git(fx.trunk, "git rev-parse refs/heads/main")).toBe(fx.expectedCurrentSha);
    } finally {
      removeTmpDirSync(fx.root);
    }
  });
});

describe("rewriteCheckedOutRefBackwards", () => {
  it("rewinds ref, index and worktree together, naming the reflog", async () => {
    const fx = setupLandscape();
    try {
      await runAdvance({
        rootDir: fx.landing,
        newSha: fx.newSha,
        expectedCurrentSha: fx.expectedCurrentSha,
      });

      await rewriteCheckedOutRefBackwards({
        worktreePath: fx.trunk,
        integrationBranch: "main",
        targetSha: fx.expectedCurrentSha,
        expectedCurrentSha: fx.newSha,
        reason: "fusion rollback: STAS-292",
      });

      expect(git(fx.trunk, "git rev-parse HEAD")).toBe(fx.expectedCurrentSha);
      expect(git(fx.trunk, "git rev-parse refs/heads/main")).toBe(fx.expectedCurrentSha);
      expect(git(fx.trunk, "git write-tree")).toBe(git(fx.trunk, "git rev-parse HEAD^{tree}"));
      expect(git(fx.trunk, "git status --porcelain")).toBe("");
      expect(existsSync(join(fx.trunk, "landed.txt"))).toBe(false);
      expect(git(fx.trunk, "git log -g refs/heads/main --format=%gs").split("\n")[0]).toContain(
        "fusion rollback",
      );
    } finally {
      removeTmpDirSync(fx.root);
    }
  });

  it("refuses to rewind a worktree carrying uncommitted work", async () => {
    const fx = setupLandscape();
    try {
      await runAdvance({
        rootDir: fx.landing,
        newSha: fx.newSha,
        expectedCurrentSha: fx.expectedCurrentSha,
      });
      writeFileSync(join(fx.trunk, "local-notes.txt"), "uncommitted\n");

      const message = await captureRejection(
        rewriteCheckedOutRefBackwards({
          worktreePath: fx.trunk,
          integrationBranch: "main",
          targetSha: fx.expectedCurrentSha,
          expectedCurrentSha: fx.newSha,
          reason: "fusion rollback: STAS-292",
        }),
      );

      expect(message).toContain("refused");
      expect(git(fx.trunk, "git rev-parse HEAD")).toBe(fx.newSha);
      expect(existsSync(join(fx.trunk, "local-notes.txt"))).toBe(true);
    } finally {
      removeTmpDirSync(fx.root);
    }
  });
});

// The `stas-190` class: a mover that is not the trunk landing. It rewrote a
// branch another worktree had checked out, which is exactly how a checkout got
// left behind its ref without ever entering the landing path.
describe("a branch rewrite outside the landing lane", () => {
  it("refuses to rewrite a branch another worktree owns, naming that worktree", async () => {
    const fx = setupLandscape();
    try {
      const message = await captureRejection(
        autoRecoverCrossContamination({
          repoDir: fx.landing,
          branchName: "main",
          baseSha: fx.expectedCurrentSha,
          taskId: "STAS-292",
          shasToDrop: [fx.newSha],
        }),
      );

      expect(message).toContain("branch rewrite refused");
      expect(message).toContain(fx.trunk);
      expect(git(fx.trunk, "git rev-parse refs/heads/main")).toBe(fx.expectedCurrentSha);
      expect(git(fx.landing, "git rev-parse HEAD")).toBe(fx.newSha);
      expect(git(fx.landing, "git status --porcelain")).toBe("");
      expect(git(fx.trunk, "git status --porcelain")).toBe("");
    } finally {
      removeTmpDirSync(fx.root);
    }
  });
});
