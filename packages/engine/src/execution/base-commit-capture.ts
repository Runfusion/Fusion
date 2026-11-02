import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Options for {@link resolveDescendantMergeBase}.
 */
export interface DescendantMergeBaseOptions {
  /** Receives one warn per failed `git merge-base` measurement, naming the single-quoted ref. */
  logger?: { warn: (msg: string) => void };
  /** Integration branch to fork against; defaults to the historic "main" literal. */
  integrationBranch?: string;
}

/*
FNXC:BranchBaseIdentity 2026-11-02-15:52:
RUFU-445 — the descendant-of-two-merge-bases DECISION is extracted from
`resolveCapturedBaseCommitSha` into this shared seam so `resolveDiffBaseRef` (the diff/fork-point
reader used by review-input proof, merge content capture, modified-file scoping, branch-conflict
handling and worktree invariant verification) measures the integration base with the SAME rule
instead of its own origin-first shell `||` chain.

Why sharing matters: the origin-first chain picks whichever ref happens to be OLDER. In this repo
local `main` is legitimately ahead of `origin/main` (AGENTS.md: never push without operator
consent), so `merge-base HEAD origin/main` landed 628 commits behind the card's own fork point on
RUFU-281 — its 112 781-byte review input became 38 867 308 bytes of unpublished `main` history,
overflowed the 10 MiB capture buffer, and the mandatory Code Review gate refused forever with
`review-input-unprovable`. The same stale base silently widens modified-file scoping for cards that
never hit the buffer. Measured 2026-09-30 ~05:00Z in `.fusion/worktrees/rufu-281` at d6f660716d.

Ordering preserved verbatim from both settled precedents: remote-tracking ahead → remote base wins
(RUFU-217 post-rebase truth); local ahead or diverged → local base wins and never rewinds
(FN-5937 inflation guard, docs/solutions/logic-errors/files-changed-inflated-by-origin-first-base-commit.md).

This seam deliberately has NO terminal fallback: the capture caller falls back to
`git rev-parse HEAD` and `resolveDiffBaseRef` to `git rev-parse HEAD~1`, and callers branch on a
falsy result (`captureModifiedFiles` returns `[]`), so merging either fallback into the shared
helper would rewrite the other's contract.
*/
/**
 * The integration fork point of this worktree's branch: the DESCENDANT of
 * `merge-base(HEAD, <local integration branch>)` and
 * `merge-base(HEAD, origin/<integration branch>)`, or `undefined` when neither
 * ref resolves. Carries no task state — see {@link resolveCapturedBaseCommitSha}
 * for the capturing half of the same rule.
 */
export async function resolveDescendantMergeBase(
  worktreePath: string,
  options: DescendantMergeBaseOptions = {},
): Promise<string | undefined> {
  const { logger } = options;
  const branch = (options.integrationBranch ?? "main").trim() || "main";
  /*
  FNXC:Workspace 2026-06-22-09:00:
  Shell-quote with a real single-quoted POSIX literal, NOT JSON.stringify. A
  JSON double-quoted string still lets bash expand `$(...)`, backticks, and `$VAR`
  inside it; JSON.stringify is not a shell-quoting function. Git ref names can't
  legally contain backticks so there's no live injection path today, but
  single-quoting is the idiomatic safe form and stays correct if a caller ever
  passes a less-constrained ref. A single quote inside the value is escaped as
  the standard `'\''` close-reopen sequence.
  */
  const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  const localRef = shellSingleQuote(branch);
  const originRef = shellSingleQuote(`origin/${branch}`);

  const mergeBase = async (against: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execAsync(`git merge-base HEAD ${against}`, { cwd: worktreePath, encoding: "utf-8" });
      return stdout.trim() || undefined;
    } catch (err: unknown) {
      logger?.warn(`merge-base against ${against} failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };

  /*
  FNXC:BranchBaseIdentity 2026-09-13-00:05:
  RUFU-231 — record the identity the branch ACTUALLY sits on. A fresh task branch is
  created from the local integration branch and then rebased onto `<remote>/<integrationBranch>`
  by `rebaseNewWorktreeOntoRemote`. Measuring only against local main re-records the stale
  identity whenever local main is behind the remote-tracking ref (the RUFU-217 wedge: the
  branch tip WAS the remote-tracking tip while the row recorded a local-main merge-base 25
  commits behind it, so every later zero-loss `baseCommitSha..branch` check read inherited
  landed work as "unique foreign" content). Choose the DESCENDANT of the two merge-bases:
  remote-tracking ahead (post-rebase truth) wins; local ahead or diverged keeps local —
  which preserves the FN-5937 inflation guard verbatim (local-ahead never rewinds).
  */
  const isStrictDescendant = async (candidate: string, ancestor: string): Promise<boolean> => {
    if (candidate === ancestor) return false;
    try {
      await execAsync(
        `git merge-base --is-ancestor ${shellSingleQuote(ancestor)} ${shellSingleQuote(candidate)}`,
        { cwd: worktreePath, encoding: "utf-8" },
      );
      return true;
    } catch {
      return false;
    }
  };

  const [mbLocal, mbRemote] = await Promise.all([mergeBase(localRef), mergeBase(originRef)]);
  if (mbLocal && mbRemote) {
    return (await isStrictDescendant(mbRemote, mbLocal)) ? mbRemote : mbLocal;
  }
  return mbLocal ?? mbRemote;
}

/**
 * Resolve the fork-point base SHA for a freshly acquired task worktree.
 *
 * Called immediately after worktree acquisition, when the task branch was
 * just created/force-reset from the local integration branch
 * (`prepareForTask` forks from local `main` via `resolveIntegrationBranch`).
 *
 * The base is the DESCENDANT of the two measured merge-bases (see
 * {@link resolveDescendantMergeBase}), which keeps the local-first ordering that
 * the contamination-base sites in `worktree-acquisition.ts` and
 * `auto-recovery-handlers/branch-worktree.ts` already use: the merger lands
 * tasks on local main before pushing, so at fork time local main can be ahead of
 * origin/main by merged-but-unpushed commits. Measuring against origin/main
 * rewinds the base past those commits; once the post-merge rebase-and-push
 * rewrites their SHAs, `baseCommitSha..HEAD` permanently sweeps the
 * predecessors' files into this task's diff (FN-5937: in-review tasks showing
 * 31 "files changed" instead of 12).
 *
 * Returns `undefined` only when every git invocation fails (caller treats a
 * missing base as non-fatal).
 *
 * FNXC:Workspace 2026-06-21-20:10:
 * `integrationBranch` is an OPTIONAL TRAILING param defaulting to the historic
 * "main" literal so the single-repo executor caller and the real-git tests stay
 * green without change. Workspace mode (U2/KTD3) passes each sub-repo's RESOLVED
 * integration branch so per-repo base capture forks against the right branch
 * instead of a hardcoded "main". The local-first ordering (merge-base HEAD
 * <local> then origin/<branch>) is preserved per-branch to keep the
 * inflation-prevention invariant (FN-5937) intact for non-main integration
 * branches too.
 */
export async function resolveCapturedBaseCommitSha(
  worktreePath: string,
  logger?: { warn: (msg: string) => void },
  integrationBranch: string = "main",
): Promise<string | undefined> {
  /*
  FNXC:BranchBaseIdentity 2026-11-02-15:52:
  RUFU-445 — the mbLocal/mbRemote + descendant selection now lives in the shared
  `resolveDescendantMergeBase` seam above (same rule, same warn wording, same single-quote
  discipline), so the capture site and `resolveDiffBaseRef` cannot drift apart. Only this
  function's OWN terminal fallback stays here: a capture with no resolvable merge-base records
  HEAD (a freshly forked branch IS its base), which is a different contract from
  `resolveDiffBaseRef`'s `HEAD~1`.
  */
  const mergeBaseCommitSha = await resolveDescendantMergeBase(worktreePath, { logger, integrationBranch });
  if (mergeBaseCommitSha) return mergeBaseCommitSha;

  try {
    const { stdout } = await execAsync("git rev-parse HEAD", {
      cwd: worktreePath,
      encoding: "utf-8",
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
