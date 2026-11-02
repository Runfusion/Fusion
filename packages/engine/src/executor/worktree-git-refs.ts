/**
 * FNXC:CodeOrganization 2026-08-03-14:00:
 * Worktree git base-ref helpers peeled from TaskExecutor (U4 Slice B start).
 * Pure relative to executor instance state — only need cwd + git exec.
 */
import { exec, execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import type { Task } from "@fusion/core";
import { resolveCapturedBaseCommitSha, resolveDescendantMergeBase } from "../execution/base-commit-capture.js";
import { executorLog } from "../logger.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** True when a pre-execution worktree holds commits past its base or any uncommitted change. */
export async function preExecutionWorktreeHasWork(worktreePath: string): Promise<boolean> {
  try {
    const { stdout: dirty } = await execFileAsync("git", ["status", "--porcelain"], { cwd: worktreePath, timeout: 30_000 });
    if (dirty.trim()) return true;
    const { stdout: ahead } = await execFileAsync("git", ["log", "--oneline", "@{upstream}..HEAD"], { cwd: worktreePath, timeout: 30_000 })
      .catch(async () => await execFileAsync("git", ["log", "--oneline", "-1", "HEAD", "--not", "--remotes", "--branches=main", "--branches=master"], { cwd: worktreePath, timeout: 30_000 }));
    return Boolean(ahead.trim());
  } catch {
    // Cannot prove the worktree is clean → treat it as holding work and keep it.
    return true;
  }
}

/**
 * Resolve a fresh merge-base against the integration branch for use as a
 * contamination check reference. Unlike {@link resolveDiffBaseRef}, this
 * NEVER falls back to `task.baseCommitSha`, because a stale stored base
 * would make the contamination check flag every legitimately-merged commit
 * since that snapshot as "foreign" (FN-4417). It also never falls back to
 * `HEAD~1`, because for a newly force-reset pooled branch HEAD~1 is a
 * commit on main itself, which would yield the same false positive on a
 * smaller scale.
 *
 * Returns `undefined` when neither `origin/main` nor `main` is resolvable;
 * the caller is expected to treat that as "contamination check skipped".
 */
export async function resolveContaminationBaseRef(worktreePath: string): Promise<string | undefined> {
  // Prefer LOCAL main over origin/main. origin/main is a tracking ref that
  // is only as fresh as the last `git fetch` — on dev machines that haven't
  // pushed in a while it can lag local main by hundreds of commits, which
  // re-introduces the FN-4417 false positive at a smaller scale (the
  // merge-base falls back to the last common ancestor between HEAD and the
  // stale origin/main, and every commit on local main since then looks
  // "foreign"). Local main is the canonical integration target for Fusion.
  try {
    const { stdout } = await execAsync(
      "git merge-base HEAD main 2>/dev/null || git merge-base HEAD origin/main",
      { cwd: worktreePath, encoding: "utf-8" },
    );
    const ref = stdout.trim();
    return ref || undefined;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.warn(`Failed merge-base lookup for contamination check in ${worktreePath}: ${errorMessage}`);
    return undefined;
  }
}

/**
 * Resolve the base ref a diff must be measured FROM for this worktree: a stored
 * `baseCommitSha` when present, else the integration fork point (see
 * {@link resolveDescendantMergeBase}). Falls back to `git rev-parse HEAD~1` and
 * finally `undefined` when no merge-base resolves — callers must treat a falsy
 * result as "no diff evidence", never as "no changes".
 *
FNXC:ReviewInputProof 2026-11-02-15:52:
RUFU-445 — the diff base is the INTEGRATION fork point, never whichever ref happens to be older.
`resolveDiffBaseRef` was the last origin-first outlier in `packages/engine/src`: its
`git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main` chain tried local `main`
only when the remote command FAILED, so a local `main` that is legitimately AHEAD — this repo never
pushes without operator consent (AGENTS.md) — produced a base hundreds of commits stale.

Measured on RUFU-281 (worktree `.fusion/worktrees/rufu-281`, HEAD d6f660716d, 2026-09-30 ~05:00Z):
no stored `baseCommitSha` (1 of 244 task mirrors), local `main` 709 commits ahead of `origin/main`,
so the computed base was e0b25b4ccd — 628 commits behind the card's real fork point. The reviewer's
"input" became 628 commits of unpublished `main` history instead of the card's 9 commits:
`git diff --binary e0b25b4ccd..HEAD` overflowed the 10 MiB child-process buffer (38 867 308 B, of
which 10 470 778 B captured) while the true base de0b9a3856 yields 112 781 B, so the mandatory
Code Review gate refused every attempt with `review-input-unprovable` and never dispatched a
reviewer. The same stale base also widened `captureModifiedFiles` scoping silently for cards that
never hit the buffer.

Resolution: delegate to the SAME descendant-of-two-merge-bases rule RUFU-231 already uses at capture
time (`resolveDescendantMergeBase`), so remote-tracking-ahead still wins (RUFU-217) and local-ahead
still never rewinds (FN-5937). Each caller keeps its own terminal fallback: this one stays
`git rev-parse HEAD~1` → `undefined`, because callers branch on a falsy base
(`captureModifiedFiles` returns `[]`) — calling the capture helper wholesale would silently swap in
its `git rev-parse HEAD` contract.
*/
export async function resolveDiffBaseRef(worktreePath: string, baseCommitSha?: string): Promise<string | undefined> {
  if (baseCommitSha) return baseCommitSha;

  const mergeBaseRef = await resolveDescendantMergeBase(worktreePath, {
    logger: { warn: (msg) => executorLog.warn(`Failed merge-base lookup for diff base in ${worktreePath}: ${msg}`) },
  });
  if (mergeBaseRef) return mergeBaseRef;

  try {
    const { stdout } = await execAsync("git rev-parse HEAD~1", {
      cwd: worktreePath,
      encoding: "utf-8",
    });
    return stdout.trim() || undefined;
  } catch {
    executorLog.debug(`Could not determine base commit for diff in ${worktreePath}`);
    return undefined;
  }
}

export type CaptureBaseCommitShaStore = {
  updateTask: (taskId: string, patch: { baseCommitSha: string }) => Promise<unknown>;
};

/**
 * Persist a baseCommitSha for the task, preserving a still-valid resume base.
 * Needs store.updateTask — inject the store rather than TaskExecutor.
 */
export async function captureBaseCommitSha(
  store: CaptureBaseCommitShaStore,
  task: Task,
  worktreePath: string,
  audit: { git: (event: { type: "commit:create"; target: string; metadata: Record<string, unknown> }) => Promise<void> },
  options: { isResume: boolean } = { isResume: false },
): Promise<void> {
  try {
    // Preserve an existing baseCommitSha only on RESUME of the same
    // worktree, where diff-base stability across sessions of the same task
    // matters. On fresh/pooled acquisitions the branch was just
    // force-reset to current main, so any stored baseCommitSha is by
    // definition behind the new merge-base — preserving it would yield
    // stale diff math and (when reused as a contamination reference) the
    // FN-4417 false-positive cascade. Always recapture on non-resume.
    if (options.isResume && task.baseCommitSha) {
      try {
        execSync(`git merge-base --is-ancestor ${task.baseCommitSha} HEAD`, {
          cwd: worktreePath,
          stdio: "pipe",
        });
        executorLog.log(`${task.id}: preserved baseCommitSha ${task.baseCommitSha.slice(0, 7)} (resume)`);
        await audit.git({
          type: "commit:create",
          target: task.baseCommitSha,
          metadata: { purpose: "base", preserved: true },
        });
        return;
      } catch {
        // Existing baseCommitSha is stale or invalid. Recapture below.
      }
    }

    const baseCommitSha = await resolveCapturedBaseCommitSha(worktreePath, {
      warn: (msg) => executorLog.warn(`${task.id}: ${msg}`),
    });
    if (!baseCommitSha) {
      throw new Error("could not resolve base commit SHA");
    }

    await store.updateTask(task.id, { baseCommitSha });
    /*
    FNXC:EngineDiagnostics 2026-08-03-05:54:
    Base-SHA capture is per-task setup bookkeeping (also in run-audit). Worktree created stays info.
    */
    executorLog.debug(`${task.id}: captured baseCommitSha ${baseCommitSha.slice(0, 7)}`);
    await audit.git({ type: "commit:create", target: baseCommitSha, metadata: { purpose: "base", preserved: false } });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.debug(`Failed to capture baseCommitSha for ${task.id}: ${errorMessage}`);
    // Non-fatal: task can continue without baseCommitSha
  }
}
