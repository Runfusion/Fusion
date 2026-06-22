/*
FNXC:Workspace 2026-06-22-14:10 (Phase D review G — dissolve self-healing ↔ merger-ai cycle):
`isRepoLanded` is a PURE per-repo git predicate. It used to live in merger-ai.ts, but Phase D
self-healing imports it (`self-healing.ts` → `merger-ai.ts`) while `merger-ai.ts` already imports
`MIN_TEMP_WORKTREE_REAP_AGE_MS` from `self-healing.ts` — a real import cycle. Moving the predicate
(plus the two tiny read-only git helpers it needs) into this dependency-free module breaks the
cycle: BOTH merger-ai.ts and self-healing.ts import from here, and neither imports the other for
this predicate. The module pulls in NOTHING beyond node:child_process, so it is a clean extraction.
The public `isRepoLanded` export from index.ts is preserved by re-exporting from this module.
*/
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Canonical Fusion task-id trailer key stamped on every land squash commit. */
export const FUSION_TASK_ID_TRAILER_KEY = "Fusion-Task-Id";

async function git(args: string[], cwd: string, opts: { timeout?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: opts.timeout ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Run git, returning true on exit 0 and false on any failure (read-only probes). */
async function gitOk(args: string[], cwd: string): Promise<boolean> {
  try {
    await git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * FNXC:Workspace 2026-06-22-04:10 (Phase C review A1):
 * Capture git stdout, returning undefined (never throwing) on failure — for read-only
 * probes (merge-base, log --grep) where a non-zero exit is an expected "not found".
 */
async function gitCapture(args: string[], cwd: string): Promise<string | undefined> {
  try {
    return await git(args, cwd);
  } catch {
    return undefined;
  }
}

/**
 * FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
 * Landed predicate: a sub-repo is landed iff a `landedSha` is recorded AND that sha is
 * an ancestor of (or equals) the repo's CURRENT integration tip. The ancestor check
 * (not just sha presence) survives a later un-related advance of the integration ref:
 * the landed commit is still reachable, so the repo stays "landed". A `landedSha` that
 * is NOT reachable from the tip (e.g. the ref was reset/rebuilt) reads as NOT landed and
 * the repo re-lands.
 *
 * FNXC:Workspace 2026-06-22-04:10 (Phase C review A1 — task-trailer ancestor fallback):
 * The double-land window: a land advances the integration ref via `advanceIntegrationBranchRef`'s
 * CAS, then `persistRepoLandedSha` records `landedSha`. If that DB write fails AFTER the ref
 * advanced, the repo is ACTUALLY landed but has NO recorded `landedSha`, so the landedSha check
 * above reports NOT-landed → a retry re-runs `landOneRepo`, the CAS rebuilds, and a SECOND squash
 * lands (not idempotent). To close the window we ALSO treat the repo as landed when the live
 * integration ref carries a commit with THIS task's `Fusion-Task-Id` trailer.
 *
 * Why a trailer scan and NOT a branch-tip ancestor check: the land is a `git merge --squash`,
 * whose squash commit's parent is the integration tip, NOT the task branch — so `merge-base
 * --is-ancestor <branch> <integration>` is FALSE even right after a successful land. The
 * `Fusion-Task-Id` trailer (always stamped onto the squash by `taskTrailers` + the
 * ensureTaskMetadata safety net) is the only reliable "this task's work is already on the ref"
 * signal that does not depend on the landedSha row, so it is what survives a lost persist. We
 * bound the scan to commits the integration tip has gained since the branch's merge-base (the
 * land base) so an unrelated historical reuse of the same trailer cannot false-positive.
 *
 * Exported (A6) so Phase D self-healing reuses THIS canonical predicate instead of
 * reimplementing the ancestor/trailer check.
 */
export async function isRepoLanded(
  repoRootDir: string,
  integrationBranch: string,
  landedSha: string | undefined,
  taskId?: string,
  branch?: string,
): Promise<boolean> {
  const intRef = `refs/heads/${integrationBranch}`;
  if (!(await gitOk(["rev-parse", "--verify", intRef], repoRootDir))) {
    return false;
  }
  // Primary: recorded landedSha is an ancestor of (or equals) the integration tip.
  // `merge-base --is-ancestor X Y` exits 0 iff X is an ancestor of (or equal to) Y.
  if (
    landedSha &&
    (await gitOk(["merge-base", "--is-ancestor", landedSha, intRef], repoRootDir))
  ) {
    return true;
  }
  // A1 fallback: even without a recorded landedSha, the repo is already landed if the
  // integration ref carries a commit with this task's Fusion-Task-Id trailer (the squash
  // we lost the persist for). Bound the scan to commits gained since the branch's land base
  // so a stale historical trailer of the same id cannot false-positive.
  if (taskId) {
    const branchRef = branch ? `refs/heads/${branch}` : undefined;
    let range = intRef;
    if (branchRef && (await gitOk(["rev-parse", "--verify", branchRef], repoRootDir))) {
      const base = await gitCapture(["merge-base", branchRef, intRef], repoRootDir);
      if (base) range = `${base.trim()}..${intRef}`;
    }
    const trailer = `${FUSION_TASK_ID_TRAILER_KEY}: ${taskId}`;
    const found = await gitCapture(
      ["log", "--format=%H", `--grep=${trailer}`, "--fixed-strings", range],
      repoRootDir,
    );
    if (found && found.trim().length > 0) return true;
  }
  return false;
}
