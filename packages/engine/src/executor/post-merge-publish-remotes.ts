/**
 * Publishing-remote discovery for the post-merge CI-repository refusal (RUFU-375).
 *
 * The refusal an operator sees when `postMergeCiRepo` is unset has to name where a branch may be published,
 * because the wrong remedy for "the CI run is not where you looked" is "make the evidence appear somewhere"
 * — a push or a pull request against the canonical upstream. Only the engine can ask git that question
 * (`@fusion/core` never shells out), so this module owns exactly that read and nothing else: core owns the
 * rule (`resolvePostMergePublishTargetFacts`), this file owns the observation.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/*
FNXC:PostMergeCiRepository 2026-10-11-00:37 (RUFU-375):
`git remote` (names only, never `git remote -v`): the -v form prints fetch AND push URLs, and a remote URL can
carry an embedded credential. Names are enough to answer "which publishing targets exist" and are the only
thing that may reach a task log or an operator-facing refusal. Async `exec` with a short timeout, not
`execSync`, per the engine's no-blocking-shellout rule; any failure yields an empty list, because a refusal
that cannot enumerate targets must degrade to "no publish target is configured", never to a second failure.
*/
/**
 * List the git remote NAMES configured at a repository root.
 *
 * @param repoDir directory to ask (a task worktree or the project root)
 * @param run injectable command runner so the degraded path is testable without git
 * @returns remote names in git's own order; empty when they cannot be read
 */
export async function listConfiguredRemoteNames(
  repoDir: string,
  run: (cwd: string) => Promise<string> = defaultRun,
): Promise<string[]> {
  try {
    const stdout = await run(repoDir);
    return [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0))];
  } catch {
    return [];
  }
}

async function defaultRun(cwd: string): Promise<string> {
  const { stdout } = await execAsync("git remote", { cwd, timeout: 5_000 });
  return stdout;
}
