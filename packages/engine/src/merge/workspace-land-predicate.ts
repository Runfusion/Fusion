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
/**
 * FNXC:Workspace 2026-07-07-10:20 (Phase C A1 recovery precision — Greptile P1):
 * Returns the EXACT proven landed commit (not just a boolean). Callers that need to record
 * `landedSha` after a lost persist must use this, because the integration tip may have advanced
 * past the actual landing commit (another sub-repo landing in between). The A1 trailer scan
 * captures the commit carrying this task's trailer in the bounded range; `git log` is
 * reverse-chronological so the first `%H` is the task's own landing commit, not a later unrelated tip.
 */
export async function findProvenLandedCommit(
  repoRootDir: string,
  integrationBranch: string,
  landedSha: string | undefined,
  taskId?: string,
  branch?: string,
): Promise<string | undefined> {
  const intRef = `refs/heads/${integrationBranch}`;
  if (!(await gitOk(["rev-parse", "--verify", intRef], repoRootDir))) {
    return undefined;
  }
  // Primary: recorded landedSha is an ancestor of (or equals) the integration tip — that SHA
  // IS the exact landing commit.
  if (
    landedSha &&
    (await gitOk(["merge-base", "--is-ancestor", landedSha, intRef], repoRootDir))
  ) {
    return landedSha;
  }
  // A1 fallback: the commit carrying this task's Fusion-Task-Id trailer in the bounded range
  // is the exact proven landing commit. Bound the scan to commits gained since the branch's
  // land base so a stale historical trailer of the same id cannot false-positive.
  if (taskId) {
    const branchRef = branch ? `refs/heads/${branch}` : undefined;
    let range = intRef;
    if (branchRef && (await gitOk(["rev-parse", "--verify", branchRef], repoRootDir))) {
      const base = await gitCapture(["merge-base", branchRef, intRef], repoRootDir);
      if (base) range = `${base.trim()}..${intRef}`;
    }
    const trailer = `${FUSION_TASK_ID_TRAILER_KEY}: ${taskId}`;
    /*
    FNXC:Workspace 2026-07-07-10:50 (Phase C A1 precision — Greptile P1, trailer-line verification):
    `git log --grep=<trailer> --fixed-strings` is a substring search over the WHOLE commit message,
    so a later changelog/diagnostic commit that merely mentions the trailer text in its body would
    be selected over the actual squash commit. Use --grep only as a prefilter, then require an actual
    trailer LINE (a line whose trimmed text is exactly the trailer) via `git show -s --format=%B`.
    Candidates are reverse-chronological, so the first one with an exact trailer line is the task's
    own landing commit.
    */
    const candidates = await gitCapture(
      ["log", "--format=%H", `--grep=${trailer}`, "--fixed-strings", range],
      repoRootDir,
    );
    if (candidates) {
      for (const sha of candidates.trim().split("\n")) {
        if (!sha) continue;
        const body = await gitCapture(["show", "-s", "--format=%B", sha], repoRootDir);
        if (body && body.split("\n").some((line) => line.trim() === trailer)) {
          return sha;
        }
      }
    }
  }
  return undefined;
}

export async function isRepoLanded(
  repoRootDir: string,
  integrationBranch: string,
  landedSha: string | undefined,
  taskId?: string,
  branch?: string,
): Promise<boolean> {
  return Boolean(
    await findProvenLandedCommit(repoRootDir, integrationBranch, landedSha, taskId, branch),
  );
}
