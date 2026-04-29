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

export interface ResolveDiffBaseOptions {
  /**
   * Display-only recovery: when `baseBranch` is missing, also try
   * `merge-base(headRef, "main")` (then `origin/main`) and prefer it over
   * `baseCommitSha` if it's a descendant of `baseCommitSha` (i.e. tighter).
   * Catches two cases:
   *
   * 1. **Stale baseCommitSha** (FN-2957): worktree rebased onto `origin/main`
   *    after `baseCommitSha` was recorded; baseCommitSha is no longer an
   *    ancestor of HEAD. Without recovery the code falls to `headRef~1`,
   *    showing only the latest commit's files.
   * 2. **Outdated baseCommitSha** (FN-2840): worktree rebased onto newer
   *    `main`; baseCommitSha is *still* an ancestor of HEAD but the range
   *    `baseCommitSha..HEAD` now sweeps in upstream main commits as if they
   *    were task changes (33 files instead of the 4 the task actually
   *    touched). The merge-base is a tighter, more accurate fork point.
   *
   * Display-only — the merger never opts in. Its scope checks must stay
   * tied to the recorded task base, not a widened display range.
   *
   * Default: false.
   */
  enableDisplayRecovery?: boolean;
}

/**
 * Resolve the diff base ref for a task worktree.
 *
 * IMPORTANT: `packages/engine/src/merger.ts` mirrors this exact ordering for
 * merge-time scope warnings. Keep both implementations in sync so dashboard
 * changed-files views and merger scope enforcement evaluate the same range.
 * The `enableDisplayRecovery` option is *display-only* and intentionally not
 * mirrored in the merger.
 *
 * Strategy (in priority order):
 * 1. **Branch merge-base** — Prefer the live merge-base between `headRef` and
 *    local `{baseBranch}` (fallback: `origin/{baseBranch}`).
 * 2. **Task-scoped baseCommitSha** — If merge-base is unavailable or equals
 *    `headRef`, use `baseCommitSha` when still an ancestor of `headRef`.
 * 3. **Display recovery (opt-in)** — `merge-base(headRef, "main")` /
 *    `origin/main` when steps 1 and 2 yielded nothing.
 * 4. **headRef~1** — Last-resort fallback.
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
  options: ResolveDiffBaseOptions = {},
): Promise<string | undefined> {
  // When baseBranch was nulled (e.g., upstream dep merged and its branch was
  // deleted) but a task-scoped baseCommitSha is still recorded, skip the
  // merge-base step so we don't widen the diff range to merge-base(HEAD, main)
  // and surface unrelated history. Only fall back to "main" when neither hint
  // is available (legacy tasks).
  const baseBranch = task.baseBranch?.trim() || (task.baseCommitSha ? undefined : "main");
  let mergeBase: string | undefined;

  if (baseBranch) {
    try {
      try {
        mergeBase = (await runGit(["merge-base", headRef, baseBranch], cwd, 5000)).trim() || undefined;
      } catch {
        mergeBase = (await runGit(["merge-base", headRef, `origin/${baseBranch}`], cwd, 5000)).trim() || undefined;
      }
    } catch {
      // base branch may no longer exist locally/remotely
    }
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

  // Display-only recovery: compute merge-base(HEAD, main) when baseBranch is
  // missing. Used both to recover from a stale baseCommitSha and to tighten
  // an outdated-but-still-ancestor baseCommitSha. See ResolveDiffBaseOptions.
  let recoveredBase: string | undefined;
  if (options.enableDisplayRecovery && !task.baseBranch?.trim()) {
    try {
      recoveredBase = (await runGit(["merge-base", headRef, "main"], cwd, 5000)).trim() || undefined;
    } catch {
      try {
        recoveredBase = (await runGit(["merge-base", headRef, "origin/main"], cwd, 5000)).trim() || undefined;
      } catch {
        // no recovery available
      }
    }
  }

  if (task.baseCommitSha) {
    let baseShaIsAncestor = false;
    try {
      await runGit(["merge-base", "--is-ancestor", task.baseCommitSha, headRef], cwd, 5000);
      baseShaIsAncestor = true;
    } catch {
      // stale or unreachable
    }

    if (baseShaIsAncestor) {
      // Prefer recoveredBase only if it's strictly tighter (a descendant of
      // baseCommitSha). When baseCommitSha is on a deleted feature branch
      // it won't be an ancestor of merge-base(HEAD, main), so we keep the
      // task-scoped SHA — preserves FN-2855 behavior.
      if (recoveredBase && recoveredBase !== task.baseCommitSha) {
        try {
          await runGit(["merge-base", "--is-ancestor", task.baseCommitSha, recoveredBase], cwd, 5000);
          return recoveredBase;
        } catch {
          // recoveredBase not a descendant — keep baseCommitSha
        }
      }
      return task.baseCommitSha;
    }
  }

  // baseCommitSha unusable (stale or unset) — use recoveredBase if available.
  if (recoveredBase) return recoveredBase;

  try {
    return (await runGit(["rev-parse", `${headRef}~1`], cwd, 5000)).trim() || undefined;
  } catch {
    return undefined;
  }
}
