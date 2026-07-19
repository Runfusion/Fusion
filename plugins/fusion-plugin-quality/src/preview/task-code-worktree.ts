import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/*
FNXC:Quality 2026-07-15-23:23:
When Quality starts a preview or test run for a task whose live worktree is gone
(typical for done tasks after land/cleanup), recreate a disposable QA worktree
checked out at the task's branch tip or merge commit so the process runs the
done task's code — not bare project root/mainline.

Paths live under <projectRoot>/.fusion/quality-qa/<taskId> so the engine's
`.worktrees` pool sweeps do not treat them as idle task checkouts.
*/

const execFileAsync = promisify(execFile);

export type TaskCodeCwdKind = "worktree" | "qa-worktree";

export interface TaskForCodeWorktree {
  id: string;
  worktree?: string | null;
  branch?: string | null;
  mergeDetails?: { commitSha?: string | null } | null;
}

export interface ResolvedTaskCodeCwd {
  cwd: string;
  cwdKind: TaskCodeCwdKind;
  /** Git ref used for a QA worktree (branch name or commit SHA). */
  ref?: string;
  created: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return String(stdout ?? "").trim();
}

async function refExists(projectRoot: string, ref: string): Promise<boolean> {
  try {
    await git(projectRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

/** Stable on-disk path for a disposable Quality QA worktree. */
export function qualityQaWorktreePath(projectRoot: string, taskId: string): string {
  const safe = taskId.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
  return join(projectRoot, ".fusion", "quality-qa", safe);
}

/**
 * Candidate refs for a done (or worktree-less) task, highest preference first:
 * 1. recorded task.branch
 * 2. conventional fusion/<taskId> branch (lowercase id)
 * 3. mergeDetails.commitSha (landed squash/merge commit)
 */
export function candidateTaskCodeRefs(task: TaskForCodeWorktree): string[] {
  const refs: string[] = [];
  const branch = typeof task.branch === "string" ? task.branch.trim() : "";
  if (branch) refs.push(branch);
  const fusionBranch = `fusion/${task.id.toLowerCase()}`;
  if (!refs.includes(fusionBranch)) refs.push(fusionBranch);
  const mergeSha =
    typeof task.mergeDetails?.commitSha === "string" ? task.mergeDetails.commitSha.trim() : "";
  if (mergeSha && !refs.includes(mergeSha)) refs.push(mergeSha);
  return refs;
}

export async function resolveTaskCodeRef(
  projectRoot: string,
  task: TaskForCodeWorktree,
): Promise<string | null> {
  for (const ref of candidateTaskCodeRefs(task)) {
    if (await refExists(projectRoot, ref)) return ref;
  }
  return null;
}

/**
 * Prefer a live task worktree; otherwise ensure a disposable QA worktree at the
 * task's branch or merge commit so done-task QA runs the task's code.
 */
export async function resolveTaskCodeCwd(input: {
  task: TaskForCodeWorktree;
  projectRoot: string;
}): Promise<ResolvedTaskCodeCwd> {
  const projectRoot = input.projectRoot.trim() || process.cwd();
  const live = typeof input.task.worktree === "string" ? input.task.worktree.trim() : "";
  if (live && existsSync(live)) {
    return { cwd: live, cwdKind: "worktree", created: false };
  }

  const ref = await resolveTaskCodeRef(projectRoot, input.task);
  if (!ref) {
    const tried = candidateTaskCodeRefs(input.task).join(", ") || "(none)";
    const err = new Error(
      `Cannot resolve code for task ${input.task.id}: no live worktree and no reachable branch/merge commit (tried: ${tried})`,
    ) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }

  const path = qualityQaWorktreePath(projectRoot, input.task.id);
  if (existsSync(path)) {
    // Reuse: hard-reset to the resolved ref so a previous QA session cannot leave stale state.
    try {
      if (isCommitSha(ref)) {
        await git(path, ["checkout", "--detach", ref]);
      } else {
        await git(path, ["checkout", "--force", ref]);
      }
      await git(path, ["reset", "--hard", "HEAD"]);
      return { cwd: path, cwdKind: "qa-worktree", ref, created: false };
    } catch {
      // Fall through to recreate if the existing path is broken.
      try {
        await git(projectRoot, ["worktree", "remove", "--force", path]);
      } catch {
        // ignore — add --force below may still succeed after prune
      }
      try {
        await git(projectRoot, ["worktree", "prune"]);
      } catch {
        // ignore
      }
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  try {
    if (isCommitSha(ref)) {
      await git(projectRoot, ["worktree", "add", "--detach", "--force", path, ref]);
    } else {
      await git(projectRoot, ["worktree", "add", "--force", path, ref]);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      `Failed to create Quality QA worktree for ${input.task.id} at ${ref}: ${message}`,
    ) as Error & { statusCode?: number };
    wrapped.statusCode = 500;
    throw wrapped;
  }

  return { cwd: path, cwdKind: "qa-worktree", ref, created: true };
}
