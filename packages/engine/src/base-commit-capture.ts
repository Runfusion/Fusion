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
 */
export async function resolveCapturedBaseCommitSha(
  worktreePath: string,
  logger?: { warn: (msg: string) => void },
): Promise<string | undefined> {
  let baseCommitSha: string | undefined;
  try {
    const { stdout } = await execAsync(
      "git merge-base HEAD main 2>/dev/null || git merge-base HEAD origin/main",
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
