import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Execute a git command and return stdout as text.
 */
export async function runGitCommand(args: string[], cwd?: string, timeout = 10000): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf-8",
  });

  if (typeof result === "string") {
    return result;
  }

  if (Array.isArray(result)) {
    return String(result[0] ?? "");
  }

  if (result && typeof result === "object" && "stdout" in result) {
    return String((result as { stdout?: unknown }).stdout ?? "");
  }

  return "";
}

export interface ResolveDiffBaseTaskInput {
  baseCommitSha?: string;
  baseBranch?: string;
}

/**
 * Resolve the diff base ref for a task worktree.
 *
 * IMPORTANT: `packages/engine/src/merger.ts` mirrors this exact ordering for
 * merge-time scope warnings. Keep both implementations in sync so dashboard
 * changed-files views and merger scope enforcement evaluate the same range.
 *
 * Strategy (in priority order):
 * 1. **Branch merge-base** — Prefer the live merge-base between `headRef` and
 *    local `{baseBranch}` (fallback: `origin/{baseBranch}`).
 * 2. **Task-scoped baseCommitSha** — If merge-base is unavailable or equals
 *    `headRef`, use `baseCommitSha` when still an ancestor of `headRef`.
 * 3. **headRef~1** — Last-resort fallback.
 *
 * Note: callers must validate the worktree still belongs to the task (e.g.
 * compare `git rev-parse --abbrev-ref HEAD` to `task.branch`) before invoking
 * this. After worktree-pool reassignment the same path may host a foreign
 * branch, in which case `baseCommitSha..HEAD` would surface other tasks'
 * commits and this function has no way to detect that.
 */
export async function resolveDiffBase(
  task: ResolveDiffBaseTaskInput,
  cwd: string,
  headRef = "HEAD",
  runGit: (args: string[], cwd?: string, timeout?: number) => Promise<string> = runGitCommand,
): Promise<string | undefined> {
  const baseBranch = task.baseBranch ?? "main";
  let mergeBase: string | undefined;

  try {
    try {
      mergeBase = (await runGit(["merge-base", headRef, baseBranch], cwd, 5000)).trim() || undefined;
    } catch {
      mergeBase = (await runGit(["merge-base", headRef, `origin/${baseBranch}`], cwd, 5000)).trim() || undefined;
    }
  } catch {
    // base branch may no longer exist locally/remotely
  }

  // If merge-base equals headRef, the live merge-base would produce an empty
  // diff. Prefer task.baseCommitSha when still valid.
  if (mergeBase) {
    try {
      const head = (await runGit(["rev-parse", headRef], cwd, 5000)).trim();
      if (head && head !== mergeBase) return mergeBase;
    } catch {
      return mergeBase;
    }
  }

  if (task.baseCommitSha) {
    try {
      await runGit(["merge-base", "--is-ancestor", task.baseCommitSha, headRef], cwd, 5000);
      return task.baseCommitSha;
    } catch {
      // stale or unreachable — fall through
    }
  }

  try {
    return (await runGit(["rev-parse", `${headRef}~1`], cwd, 5000)).trim() || undefined;
  } catch {
    return undefined;
  }
}
