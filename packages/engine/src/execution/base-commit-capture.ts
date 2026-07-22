import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Resolve the fork-point base SHA for a freshly acquired task worktree.
 *
 * Called immediately after worktree acquisition, when the task branch was
 * just created/force-reset from the local integration branch
 * (`prepareForTask` forks from local `main` via `resolveIntegrationBranch`).
 *
 * The merge-base MUST be measured against LOCAL main first (origin/main only
 * as a fallback), matching the contamination-base sites in
 * `worktree-acquisition.ts` and `auto-recovery-handlers/branch-worktree.ts`.
 * The merger lands tasks on local main before pushing, so at fork time local
 * main can be ahead of origin/main by merged-but-unpushed commits. Measuring
 * against origin/main rewinds the base past those commits; once the
 * post-merge rebase-and-push rewrites their SHAs, `baseCommitSha..HEAD`
 * permanently sweeps the predecessors' files into this task's diff (FN-5937:
 * in-review tasks showing 31 "files changed" instead of 12).
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
  const branch = integrationBranch.trim() || "main";
  /*
  FNXC:Workspace 2026-06-22-09:00:
  Shell-quote with a real single-quoted POSIX literal, NOT JSON.stringify. A
  JSON double-quoted string still lets bash expand `$(...)`, backticks, and `$VAR`
  inside it; JSON.stringify is not a shell-quoting function. Git ref names can't
  legally contain backticks so there's no live injection path today, but
  single-quoting is the idiomatic safe form and stays correct if a caller ever
  passes a less-constrained string. A single quote inside the value is escaped as
  the standard `'\''` close-reopen sequence.
  */
  const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  const localRef = shellSingleQuote(branch);
  const originRef = shellSingleQuote(`origin/${branch}`);
  let baseCommitSha: string | undefined;
  try {
    const { stdout } = await execAsync(
      `git merge-base HEAD ${localRef} 2>/dev/null || git merge-base HEAD ${originRef}`,
      { cwd: worktreePath, encoding: "utf-8" },
    );
    baseCommitSha = stdout.trim() || undefined;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger?.warn(`merge-base failed, falling back to HEAD: ${errorMessage}`);
  }

  if (!baseCommitSha) {
    try {
      const { stdout } = await execAsync("git rev-parse HEAD", {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      baseCommitSha = stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  return baseCommitSha;
}
