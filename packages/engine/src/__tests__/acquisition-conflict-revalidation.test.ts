/*
 * Surface enumeration: this covers the engine live-git revalidation surface; no desktop/mobile UI applies.
 *
 * FNXC:AcquisitionConflictRevalidation 2026-11-01-13:20 (RUFU-356):
 * Every case here is built from a real git repository because the whole claim of this module is that
 * the recovery decision tracks LIVE git. A fake git layer would let the module pass by inventing an
 * absence the product never proves — which is precisely the RUFU-376 phantom-worktree defect. The
 * fixtures reproduce the RUFU-278 condition by deleting paths on disk, and each refusing case is the
 * negative control for one cleared case: same branch, same commits, one surviving physical side.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Task } from "@fusion/core";
import {
  acquisitionConflictAuditCode,
  isAcquisitionExhaustionError,
  isAcquisitionPremiseCleared,
  isAcquisitionPremiseRefusing,
  readAcquisitionConflictLaneState,
  rederiveAcquisitionConflictPremise,
} from "../worktree/acquisition-conflict-revalidation.js";
import { resolveTaskWorktreePath } from "../worktree/worktree-paths.js";

/** Quote one argv token so a commit message with spaces survives the shell the fixture runs through. */
function quote(value: string): string {
  return `"${value.replace(/["\\]/g, "")}"`;
}

/** Runs one git command; every call site below reads as plain git argv. */
const git = (cwd: string, argv: string) =>
  execSync(`git ${argv}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

/*
 * The id is shaped like a real card id (`<PREFIX>-<digits>`) on purpose: commit attribution recognizes
 * that shape (TASK_ID_TOKEN_SOURCE) and a trailing letter would make every "own work" fixture read as
 * unattributed, turning the reclaimable cases into foreign-unmerged for a reason that has nothing to
 * do with what is being tested.
 */
const TASK_ID = "RUFU-3560";
const BRANCH = `fusion/${TASK_ID.toLowerCase()}`;

function makeTask(overrides: Partial<Task> = {}): Pick<Task, "id" | "branch" | "branchContext"> {
  return { id: TASK_ID, branch: BRANCH, branchContext: undefined, ...overrides } as Pick<
    Task,
    "id" | "branch" | "branchContext"
  >;
}

interface Fixture {
  repoDir: string;
  /** The default-layout pinned destination native acquisition derives for this card. */
  pinnedPath: string;
  /** The `.git/worktrees/<name>` admin directory git keeps for a linked worktree. */
  adminDir: string;
}

function fixture(): Fixture {
  const repoDir = mkdtempSync(join(tmpdir(), "rufu-356-"));
  git(repoDir, "init -q -b main");
  git(repoDir, "config user.email executor@example.invalid");
  git(repoDir, "config user.name Executor");
  git(repoDir, "config commit.gpgsign false");
  writeFileSync(join(repoDir, "README.md"), "seed\n");
  // Mirrors the real product repository: the worktrees root is ignored, so a worktree checkout is
  // never accidentally staged by an `add -A` in the main checkout.
  writeFileSync(join(repoDir, ".gitignore"), ".fusion/worktrees/\n");
  git(repoDir, "add -A");
  git(repoDir, 'commit -q -m "chore: seed"');
  // FN-258 pins the default-layout destination by lower-cased task id, so the card id is uppercase here.
  const pinnedPath = join(repoDir, ".fusion", "worktrees", TASK_ID.toLowerCase());
  mkdirSync(join(repoDir, ".fusion", "worktrees"), { recursive: true });
  return { repoDir, pinnedPath, adminDir: join(repoDir, ".git", "worktrees", basename(pinnedPath)) };
}

/** Register the card's branch on a live checkout at its pinned destination, the shape acquisition refused. */
function registerCardWorktree(f: Fixture): void {
  git(f.repoDir, `worktree add -q -b ${BRANCH} "${f.pinnedPath}" HEAD`);
}

function commitIn(path: string, subject: string, message?: string): string {
  writeFileSync(join(path, `note-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`), subject);
  git(path, "add -A");
  git(path, message ? `commit -q -m ${quote(subject)} -m ${quote(message)}` : `commit -q -m ${quote(subject)}`);
  return git(path, "rev-parse HEAD");
}

const OWN_TRAILER = `Fusion-Task-Id: ${TASK_ID}`;

const repos: string[] = [];
afterEach(() => repos.splice(0).forEach((repo) => rmSync(repo, { recursive: true, force: true })));

function track(repoDir: string): string {
  repos.push(repoDir);
  return repoDir;
}

const probe = (repoDir: string, task = makeTask()) =>
  rederiveAcquisitionConflictPremise({ rootDir: repoDir, settings: undefined, task, logger: { warn: () => undefined } });
const lane = (repoDir: string, task = makeTask()) =>
  readAcquisitionConflictLaneState({ rootDir: repoDir, settings: undefined, task, logger: { warn: () => undefined } });

describeIfGitAvailable("acquisition conflict revalidation (real git)", () => {
  it("derives the pinned destination identity the probe claims to use", async () => {
    const f = fixture();
    track(f.repoDir);
    // The fixture hardcodes the layout instead of calling the resolver, so a drift in the identity
    // input (FN-258 task-id pinning, default root) fails the cases below rather than hiding in here.
    expect(resolveTaskWorktreePath(f.repoDir, undefined, TASK_ID.toLowerCase())).toBe(f.pinnedPath);
  });

  it("clears the RUFU-278 shape: path, registration, and admin directory all removed, own work intact", async () => {
    const f = fixture();
    track(f.repoDir);
    registerCardWorktree(f);
    commitIn(f.pinnedPath, "feat(RUFU-3560): own work", OWN_TRAILER);

    rmSync(f.pinnedPath, { recursive: true, force: true });
    rmSync(f.adminDir, { recursive: true, force: true });

    await expect(lane(f.repoDir)).resolves.toBe("absent");
    const outcome = await probe(f.repoDir);
    expect(outcome).toBe("reclaimable");
    expect(isAcquisitionPremiseCleared(outcome)).toBe(true);
    expect(acquisitionConflictAuditCode(outcome)).toBe("premise-cleared");
  });

  it("treats a registration-only leftover as healed, because prune — not a guessed path — decides", async () => {
    const f = fixture();
    track(f.repoDir);
    registerCardWorktree(f);
    commitIn(f.pinnedPath, "fix(RUFU-3560): own work", OWN_TRAILER);

    // Only the working tree goes: the registration and the admin directory are still on disk.
    rmSync(f.pinnedPath, { recursive: true, force: true });

    await expect(lane(f.repoDir)).resolves.toBe("absent");
    await expect(probe(f.repoDir)).resolves.toBe("reclaimable");
  });

  it("keeps refusing while the branch is still checked out on a live path", async () => {
    const f = fixture();
    track(f.repoDir);
    registerCardWorktree(f);
    commitIn(f.pinnedPath, "feat(RUFU-3560): unmerged work", OWN_TRAILER);

    await expect(lane(f.repoDir)).resolves.toBe("live-registration");
    const outcome = await probe(f.repoDir);
    expect(outcome).toBe("live-foreign");
    expect(isAcquisitionPremiseCleared(outcome)).toBe(false);
    expect(isAcquisitionPremiseRefusing(outcome)).toBe(true);
    expect(acquisitionConflictAuditCode(outcome)).toBe("live-registration");
  });

  it("keeps refusing when the destination still holds content, even with no registration", async () => {
    const f = fixture();
    track(f.repoDir);
    git(f.repoDir, `branch ${BRANCH} HEAD`);
    // A leftover directory the create still trips over: never registered, but not empty.
    mkdirSync(join(f.pinnedPath, "dist"), { recursive: true });
    writeFileSync(join(f.pinnedPath, "dist", "bundle.js"), "ignored build output");

    await expect(lane(f.repoDir)).resolves.toBe("path-present");
  });

  it("clears an empty leftover destination, which is where git worktree add would simply succeed", async () => {
    const f = fixture();
    track(f.repoDir);
    git(f.repoDir, `branch ${BRANCH} HEAD`);
    mkdirSync(f.pinnedPath, { recursive: true });

    // An empty directory does not stop the create, so the lane is free; and a branch sitting exactly on
    // the integration tip has nothing to preserve, which is why the premise answer is `tip-already-merged`.
    await expect(lane(f.repoDir)).resolves.toBe("absent");
    const outcome = await probe(f.repoDir);
    expect(outcome).toBe("tip-already-merged");
    expect(isAcquisitionPremiseCleared(outcome)).toBe(true);
  });

  it("keeps refusing while surviving unregistered work belongs to somebody else", async () => {
    const f = fixture();
    track(f.repoDir);
    registerCardWorktree(f);
    commitIn(f.pinnedPath, "feat(RUFU-999): foreign work", "Fusion-Task-Id: RUFU-999");
    rmSync(f.pinnedPath, { recursive: true, force: true });
    rmSync(f.adminDir, { recursive: true, force: true });

    await expect(lane(f.repoDir)).resolves.toBe("absent");
    const outcome = await probe(f.repoDir);
    expect(outcome).toBe("foreign-unmerged");
    expect(isAcquisitionPremiseRefusing(outcome)).toBe(true);
    expect(acquisitionConflictAuditCode(outcome)).toBe("foreign-unmerged");
  });

  it("keeps refusing while surviving unregistered work carries no attribution at all", async () => {
    const f = fixture();
    track(f.repoDir);
    registerCardWorktree(f);
    commitIn(f.pinnedPath, "work with no stamp");
    rmSync(f.pinnedPath, { recursive: true, force: true });
    rmSync(f.adminDir, { recursive: true, force: true });

    await expect(probe(f.repoDir)).resolves.toBe("foreign-unmerged");
  });

  it("clears a tip that is already merged into the integration branch", async () => {
    const f = fixture();
    track(f.repoDir);
    registerCardWorktree(f);
    commitIn(f.pinnedPath, "feat(RUFU-3560): landed work", OWN_TRAILER);
    git(f.repoDir, `merge --ff-only -q ${BRANCH}`);
    rmSync(f.pinnedPath, { recursive: true, force: true });
    rmSync(f.adminDir, { recursive: true, force: true });

    const outcome = await probe(f.repoDir);
    expect(outcome).toBe("tip-already-merged");
    expect(isAcquisitionPremiseCleared(outcome)).toBe(true);
  });

  it("clears a tip whose commits are already upstream patch-for-patch (squash landed)", async () => {
    const f = fixture();
    track(f.repoDir);
    registerCardWorktree(f);
    commitIn(f.pinnedPath, "feat(RUFU-3560): squashed work", OWN_TRAILER);
    const changed = git(f.pinnedPath, "diff --name-only HEAD~1 HEAD").split("\n")[0]!;
    const content = git(f.pinnedPath, `show HEAD:${changed}`);
    writeFileSync(join(f.repoDir, changed), content);
    git(f.repoDir, `add ${quote(changed)}`);
    git(f.repoDir, 'commit -q -m "feat: squash-land the branch"');
    rmSync(f.pinnedPath, { recursive: true, force: true });
    rmSync(f.adminDir, { recursive: true, force: true });

    const outcome = await probe(f.repoDir);
    expect(outcome).toBe("fully-subsumed");
    expect(isAcquisitionPremiseCleared(outcome)).toBe(true);
  });

  it("clears a branch that never came to exist", async () => {
    const f = fixture();
    track(f.repoDir);

    await expect(lane(f.repoDir)).resolves.toBe("absent");
    const outcome = await probe(f.repoDir);
    expect(outcome).toBe("missing");
    expect(isAcquisitionPremiseCleared(outcome)).toBe(true);
  });

  it("answers probe-unknown, never absence, when git cannot be consulted", async () => {
    // A root that is not a repository at all. The underlying inspector reads an unreadable ref as
    // "branch missing", so this case is the proof that the module refuses to launder a transport
    // failure into the absence evidence that would clear a card.
    const notARepo = mkdtempSync(join(tmpdir(), "rufu-356-notrepo-"));
    track(notARepo);

    await expect(lane(notARepo)).resolves.toBe("probe-unknown");
    const outcome = await probe(notARepo);
    expect(outcome).toBe("probe-unknown");
    expect(isAcquisitionPremiseCleared(outcome)).toBe(false);
    expect(acquisitionConflictAuditCode(outcome)).toBe("probe-unknown");

    const gone = join(notARepo, "does-not-exist");
    await expect(lane(gone)).resolves.toBe("probe-unknown");
    await expect(probe(gone)).resolves.toBe("probe-unknown");
  });

  it("probes the branch the task row names, not the branch a stale message names", async () => {
    const f = fixture();
    track(f.repoDir);
    // The canonical fusion/<id> branch is deliberately never created; the work lives on a branch only
    // the row knows about, so the two probes below can only differ if the row's branch is respected.
    git(f.repoDir, "checkout -q -b other/branch");
    commitIn(f.repoDir, `feat(${TASK_ID}): own work on the row-named branch`, OWN_TRAILER);
    git(f.repoDir, "checkout -q main");

    // An explicit row branch is respected even when it is not the canonical shape.
    const onRowBranch = await probe(f.repoDir, makeTask({ branch: "other/branch" }));
    expect(onRowBranch).toBe("reclaimable");
    // No `branch` on the row: the identity falls back to the canonical fusion/<id> the envelope also used.
    await expect(probe(f.repoDir, makeTask({ branch: undefined }))).resolves.toBe("missing");
  });
});

describe("isAcquisitionExhaustionError recognizes the park envelope and nothing else", () => {
  it("recognizes the heartbeat retry-cap park sentence composed at the acquisition cap", () => {
    const envelope =
      `Worktree acquisition failed after 3 heartbeat attempts for branch "${BRANCH}": ` +
      `Branch "${BRANCH}" is already checked out at "/abs/path/.fusion/worktrees/rufu-3560"`;
    expect(isAcquisitionExhaustionError(envelope)).toBe(BRANCH);
  });

  it("recognizes it whatever the attempt cap is, so raising the constant cannot un-recognize stored parks", () => {
    expect(isAcquisitionExhaustionError('Worktree acquisition failed after 7 heartbeat attempts for branch "fusion/x": boom')).toBe("fusion/x");
  });

  it("recognizes the measured RUFU-278 sentence verbatim", () => {
    const measured =
      'Worktree acquisition failed after 3 heartbeat attempts for branch "fusion/rufu-278":\n' +
      "Branch fusion/rufu-278 is already checked out at /home/operator/git/Fusion/.fusion/worktrees/rufu-278 " +
      "(tip 6efff2d2c92f, 2 stranded commits since main). Preserve this unregistered branch and inspect its " +
      "foreign or unattributed commits before retrying.";
    expect(isAcquisitionExhaustionError(measured)).toBe("fusion/rufu-278");
  });

  it("does not recognize the base-diverged park, which has an operator-only remedy", () => {
    const diverged =
      "TASK_BASE_DIVERGED: local main has diverged from origin/main (2 ahead / 3 behind). Reconcile manually (git pull --rebase or reset) — the engine will not touch a diverged base branch.";
    expect(isAcquisitionExhaustionError(diverged)).toBeUndefined();
  });

  it("does not recognize the review-lane acquisition sentence, which is another lane's remedy", () => {
    expect(
      isAcquisitionExhaustionError(
        "Worktree acquisition failed before the review produced a verdict. Retry the task to re-run implementation.",
      ),
    ).toBeUndefined();
  });

  it("does not recognize the executor's create-failure wording, which the WIP lane owns", () => {
    expect(isAcquisitionExhaustionError('Worktree creation failed after 3 attempts for branch "fusion/x"')).toBeUndefined();
    expect(isAcquisitionExhaustionError('Failed to create worktree after 2 attempts: Branch "fusion/x" is already checked out')).toBeUndefined();
  });

  it("does not recognize the inner conflict sentence on its own, because inner wording is RUFU-376's to change", () => {
    expect(isAcquisitionExhaustionError(`Branch "${BRANCH}" is already checked out at "/abs/.fusion/worktrees/rufu-3560"`)).toBeUndefined();
  });

  it("leaves a healthy task alone", () => {
    expect(isAcquisitionExhaustionError(undefined)).toBeUndefined();
    expect(isAcquisitionExhaustionError("")).toBeUndefined();
  });
});

function describeIfGitAvailable(name: string, fn: () => void) {
  const available = (() => {
    try {
      execSync("git --version", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();
  return available ? describe(name, fn) : describe.skip(name, fn);
}
