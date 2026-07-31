/*
FNXC:SelfHealingSubstrate 2026-07-27-05:10 (U4 substrate decomposition, PR1):
GIT-EVIDENCE SUBSTRATE — pure evidence readers extracted from self-healing.ts.

These read git and the task row to answer factual questions: does this commit
belong to this task, is this branch tip foreign, did this task already land, what
did it change. None of them mutates the store. They are the safest cut in the
decomposition and the most valuable to test directly, which is why they go first.

RELOCATION, NOT REWRITE. Every body below is byte-identical to its original in
self-healing.ts. The mechanical proof is in the PR: each moved body diffed against
its pre-move text with import lines stripped. Three deviations were structurally
unavoidable and are enumerated there rather than hidden here:
  1. `private` -> `protected` on the 14 methods and the `options` field, because a
     subclass cannot call a `private` base member;
  2. two `SelfHealingManager["readCommitTaskOwnership"]` type annotations rewritten
     to reference this class, since the original would be a circular import;
  3. four module-level helpers moved with them and re-exported, because
     `escapeRegex` / `shellQuote` still have call sites left behind in
     self-healing.ts and the import must stay one-directional.

WHY A BASE CLASS AND NOT FREE FUNCTIONS: these are `private async` METHODS that
close over `this.options`. Converting them to free functions would change every
signature, which is a behavior-adjacent edit riding in a file move — exactly the
combination that hid the last four safeguard regressions. An abstract base keeps
`this` semantics and every body unchanged.
*/
import { promisify } from "node:util";
import { exec } from "node:child_process";
/* NOTE: `findAlreadyMergedTaskCommit` here is the FREE function from the
   detector module — it shares a name with the protected method below, and inside
   the class body the bare identifier resolves to this import. That collision
   pre-dates the move and is preserved exactly. */
import { findAlreadyMergedTaskCommit, getCommitTaskOwnership } from "./already-merged-detector.js";
import { createLogger } from "./logger.js";
import type { Task } from "@fusion/core";

const log = createLogger("self-healing");
/* TYPE-ONLY import: erased at runtime, so it creates no module cycle even though
   self-healing.ts imports this file's class at definition time. */
import type { SelfHealingOptions } from "./self-healing.js";

export const execAsync = promisify(exec);


export interface LandedTaskCommit {
  sha: string;
  subject?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  rebaseBaseSha?: string;
}

export function commitOwnedByTask(taskId: string, lineageId: string | undefined, subject: string, body: string): boolean {
  if (lineageId && new RegExp(`(?:^|\\n)Fusion-Task-Lineage: ${escapeRegex(lineageId)}\\s*(?:\\n|$)`).test(body)) {
    return true;
  }
  if (new RegExp(`(?:^|\\n)Fusion-Task-Id: ${escapeRegex(taskId)}\\s*(?:\\n|$)`).test(body)) {
    return true;
  }
  // Subject anchor: `<type>(<…taskId…>): …` or `<taskId>: …` at start.
  // The conventional scope group is intentionally NOT optional: a bare
  // `<type>: …` (e.g. `feat: unrelated change`) carries no task ID and is NOT
  // ownership evidence, even if the body mentions the task in prose (incident
  // bug #2 — a prose-mention must never claim a task).
  const subjectAnchor = new RegExp(
    `^(?:[A-Za-z]+\\([^)]*\\b${escapeRegex(taskId)}\\b[^)]*\\):|${escapeRegex(taskId)}:)`,
  );
  return subjectAnchor.test(subject);
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function parseShortstat(output: string): Pick<LandedTaskCommit, "filesChanged" | "insertions" | "deletions"> {
  const normalized = output.trim().replace(/\n/g, " ");
  const filesMatch = normalized.match(/(\d+) files? changed/);
  const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);

  return {
    filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
    insertions: insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0,
  };
}

/**
 * Abstract base carrying the git-evidence readers. `SelfHealingManager` extends
 * it, so every call site stays `this.<method>(...)` and every body below is the
 * original text.
 */
export abstract class SelfHealingGitEvidence {
  protected abstract readonly options: SelfHealingOptions;


  protected async findLandedTaskCommit(
    task: Task,
    options?: { preferEarliestOwnedCommit?: boolean },
  ): Promise<LandedTaskCommit | null> {
    // Search strategies, tried in order of reliability:
    //   1. mergeDetails.commitSha — already stored by the merger; verify it's
    //      reachable from HEAD before trusting it.
    //   2. Fusion-Task-Lineage trailer — canonical immutable lineage marker.
    //   3. Fusion-Task-Id trailer — legacy human task-id marker.
    //   4. Subject grep — legacy/AI commits where the task ID lives in the
    //      subject line (e.g. `feat(FN-123): …`).
    //
    // (1) gives us the right sha even if the commit subject is exotic; (2)
    // covers includeTaskIdInCommit=false setups where (3) would silently
    // miss; (3) catches commits authored before the trailer was introduced.

    // ── (1) Stored sha ────────────────────────────────────────────────────
    const rebaseBaseSha = task.mergeDetails?.rebaseBaseSha;
    const storedSha = task.mergeDetails?.commitSha;
    if (storedSha) {
      try {
        await execAsync(
          `git merge-base --is-ancestor ${shellQuote(storedSha)} HEAD`,
          { cwd: this.options.rootDir },
        );
        const { stdout } = await execAsync(
          `git log -1 --format=%H%x1f%s%x1f%b ${shellQuote(storedSha)}`,
          { cwd: this.options.rootDir, maxBuffer: 1024 * 1024 },
        );
        const [sha, subject = "", body = ""] = stdout.trim().split("\x1f");
        if (sha && commitOwnedByTask(task.id, task.lineageId, subject, body)) {
          const commit: LandedTaskCommit = { sha, subject, rebaseBaseSha };
          try {
            const shortstat = await this.readShortstatForSha(sha, rebaseBaseSha);
            if (shortstat) {
              Object.assign(commit, shortstat);
            }
          } catch { /* stats are optional */ }
          return commit;
        }
      } catch {
        // Not reachable (rebased away, branch reset, etc.) — fall through.
      }
    }

    const readLog = async (range: string, grepArg: string, fixedStrings: boolean) => {
      const command = [
        "git log",
        "--format=%H%x1f%s",
        "--max-count=20",
        ...(options?.preferEarliestOwnedCommit ? ["--reverse"] : []),
        ...(fixedStrings ? ["--fixed-strings"] : ["-E"]),
        `--grep=${grepArg}`,
        shellQuote(range),
      ].join(" ");

      return execAsync(command, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
    };

    // Search canonical lineage trailer, then legacy task-id trailer, then
    // legacy subject fallback. All share bounded/full HEAD range resolution.
    const search = async (grepArg: string, fixedStrings: boolean): Promise<string> => {
      let out: string;
      try {
        const r = await readLog(
          task.baseCommitSha ? `${task.baseCommitSha}..HEAD` : "HEAD",
          grepArg,
          fixedStrings,
        );
        out = r.stdout;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(
          `Failed to read git log for landed commit lookup (${task.id}): ${errorMessage} — retrying with HEAD range`,
        );
        if (!task.baseCommitSha) return "";
        const r = await readLog("HEAD", grepArg, fixedStrings);
        out = r.stdout;
      }
      // Bounded range may exclude the landed commit when baseCommitSha was
      // advanced past it; re-scan all of HEAD if empty.
      if (!out.trim() && task.baseCommitSha) {
        const r = await readLog("HEAD", grepArg, fixedStrings);
        out = r.stdout;
      }
      return out;
    };

    // (2) Canonical lineage trailer.
    let stdout = "";
    if (task.lineageId) {
      const lineagePattern = `^Fusion-Task-Lineage: ${task.lineageId}$`;
      stdout = await search(shellQuote(lineagePattern), false);
    }

    // (3) Legacy task-id trailer.
    if (!stdout.trim()) {
      const trailerPattern = `^Fusion-Task-Id: ${task.id}$`;
      stdout = await search(shellQuote(trailerPattern), false);
    }

    // (4) Subject grep fallback (legacy commits).
    if (!stdout.trim()) {
      stdout = await search(shellQuote(task.id), true);
    }

    // FN-5441/FN-5446 regression: `git log --grep=FN-XXXX` matches the entire
    // commit message, including prose body mentions. The previous code blindly
    // accepted the first match — which is how FN-5441/5446 got attributed to
    // an unrelated FN-5483 commit that *mentioned* them by name. Walk the
    // candidates and accept only the first one that actually owns the task
    // (anchored lineage/id trailer or subject-anchored conventional commit).
    const candidateLines = stdout.trim().split("\n").filter(Boolean);
    let sha = "";
    let subject = "";
    for (const line of candidateLines) {
      const [candidateSha, candidateSubject = ""] = line.split("\x1f");
      if (!candidateSha) continue;
      try {
        const { stdout: bodyOut } = await execAsync(
          `git log -1 --format=%b ${shellQuote(candidateSha)}`,
          { cwd: this.options.rootDir, maxBuffer: 1024 * 1024 },
        );
        if (commitOwnedByTask(task.id, task.lineageId, candidateSubject, bodyOut)) {
          sha = candidateSha;
          subject = candidateSubject;
          break;
        }
      } catch {
        // If we can't read the body, conservatively skip this candidate.
      }
    }
    if (!sha) return null;

    const commit: LandedTaskCommit = { sha, subject, rebaseBaseSha };
    try {
      const shortstat = await this.readShortstatForSha(sha, rebaseBaseSha);
      if (shortstat) {
        Object.assign(commit, shortstat);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        `Failed to read shortstat for landed commit ${sha} (${task.id}): ${errorMessage} — continuing without stats`,
      );
      // Stats are useful for the task detail view but not required for recovery.
    }

    return commit;
  }

  protected async findAlreadyMergedTaskCommit(input: {
    taskId: string;
    lineageId?: string;
    repoDir: string;
    baseBranch: string;
    taskBranch?: string;
    baseCommitSha?: string;
  }) {
    return findAlreadyMergedTaskCommit(input);
  }

  protected async refreshRemoteBaseRef(baseBranch: string): Promise<string | null> {
    // Already a remote ref — nothing local to refresh.
    if (baseBranch.startsWith("origin/")) return null;
    const remoteRef = `origin/${baseBranch}`;
    try {
      await execAsync(`git fetch origin ${shellQuote(baseBranch)}`, {
        cwd: this.options.rootDir,
        timeout: 60_000,
      });
    } catch {
      // Swallow: fall through to the existing remote-tracking ref if present.
    }
    try {
      await execAsync(`git rev-parse --verify ${shellQuote(remoteRef)}`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
      });
      return remoteRef;
    } catch {
      return null;
    }
  }

  protected async readCommitTaskOwnership(sha: string, taskId: string, lineageId?: string) {
    const { stdout } = await execAsync(`git show -s --format=%s%x1f%b ${shellQuote(sha)}`, {
      cwd: this.options.rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const [subject = "", body = ""] = stdout.split("\x1f");
    return getCommitTaskOwnership(taskId, lineageId, subject, body);
  }

  protected async branchHasNoUniqueDiff(branchTip: string, baseBranch: string): Promise<boolean> {
    const { stdout: mergeBaseStdout } = await execAsync(`git merge-base ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`, {
      cwd: this.options.rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const mergeBase = mergeBaseStdout.trim();
    if (!mergeBase) return false;

    await execAsync(`git diff --quiet ${shellQuote(mergeBase)}..${shellQuote(branchTip)}`, {
      cwd: this.options.rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  }

  protected async baseHasExplicitTaskOwnership(taskId: string, lineageId: string | undefined, baseBranch: string): Promise<boolean> {
    const patterns = lineageId
      ? [`^Fusion-Task-Lineage: ${escapeRegex(lineageId)}$`, `^Fusion-Task-Id: ${escapeRegex(taskId)}$`]
      : [`^Fusion-Task-Id: ${escapeRegex(taskId)}$`];
    for (const pattern of patterns) {
      const { stdout } = await execAsync(`git log --grep=${shellQuote(pattern)} -E --max-count=1 --format=%H ${shellQuote(baseBranch)}`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      if (stdout.trim()) return true;
    }
    return false;
  }

  protected async foreignTipRejection(input: {
    taskId: string;
    lineageId?: string;
    branchTip: string;
    baseBranch: string;
    ownership: Awaited<ReturnType<SelfHealingGitEvidence["readCommitTaskOwnership"]>>;
  }): Promise<{ reason: "foreign-task-tip" | "foreign-lineage-tip"; owner?: string } | null> {
    const { taskId, lineageId, branchTip, baseBranch, ownership } = input;
    if (ownership.rejectionReason !== "foreign-task" && ownership.rejectionReason !== "foreign-lineage") return null;

    const hasNoUniqueDiff = await this.branchHasNoUniqueDiff(branchTip, baseBranch).catch(() => false);
    const baseAlreadyHasCurrentTask = hasNoUniqueDiff
      ? await this.baseHasExplicitTaskOwnership(taskId, lineageId, baseBranch).catch(() => false)
      : false;
    if (hasNoUniqueDiff && !baseAlreadyHasCurrentTask) return null;

    return ownership.rejectionReason === "foreign-task"
      ? { reason: "foreign-task-tip", owner: ownership.ownerTaskId }
      : { reason: "foreign-lineage-tip", owner: ownership.ownerLineageId };
  }

  protected async branchTipForeignOwnership(input: {
    taskId: string;
    lineageId?: string;
    branch: string;
    baseBranch: string;
  }): Promise<{ sha: string; owner?: string; reason: "foreign-task-tip" | "foreign-lineage-tip" | "ownership-unverifiable" } | null> {
    const { taskId, lineageId, branch, baseBranch } = input;
    let stdout = "";
    try {
      ({ stdout } = await execAsync(`git rev-parse ${shellQuote(branch)}`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }));
    } catch {
      return { sha: "unverified", reason: "ownership-unverifiable" };
    }
    const sha = stdout.trim();
    if (!sha) return null;
    let ownership: Awaited<ReturnType<SelfHealingGitEvidence["readCommitTaskOwnership"]>>;
    try {
      ownership = await this.readCommitTaskOwnership(sha, taskId, lineageId);
    } catch {
      return { sha, reason: "ownership-unverifiable" };
    }
    /*
    FNXC:WorkflowRecovery 2026-07-03-21:35:
    Already-merged recovery must classify no-diff task branches before enforcing branch-tip trailers. A branch created from main can point at a previous task's landed commit and later sit behind main after unrelated commits; reject foreign trailers only when merge-base-to-tip diff proof shows the branch contains real task-branch content.

    FNXC:WorkflowRecovery 2026-07-25-09:40:
    That diff-proof classification now lives in `foreignTipRejection` so this path, branch-misbound recovery, and the reclaim sweep cannot drift apart again.
    */
    const rejection = await this.foreignTipRejection({ taskId, lineageId, branchTip: sha, baseBranch, ownership });
    if (rejection) return { sha, owner: rejection.owner, reason: rejection.reason };
    return null;
  }

  protected async isCommitReachableFromBranch(commitSha: string | undefined, branch: string): Promise<boolean> {
    if (!commitSha) return true;
    try {
      await execAsync(`git merge-base --is-ancestor ${shellQuote(commitSha)} ${shellQuote(branch)}`, {
        cwd: this.options.rootDir,
      });
      return true;
    } catch {
      return false;
    }
  }

  protected async findWorktreePathForBranch(branchName: string): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("git worktree list --porcelain", {
        cwd: this.options.rootDir,
        timeout: 30_000,
      });
      const lines = stdout.split("\n");
      let currentWorktree: string | undefined;
      let currentBranch: string | undefined;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          if (currentWorktree && currentBranch === branchName) return currentWorktree;
          currentWorktree = undefined;
          currentBranch = undefined;
          continue;
        }
        if (line.startsWith("worktree ")) {
          currentWorktree = line.slice("worktree ".length).trim();
          continue;
        }
        if (line.startsWith("branch refs/heads/")) {
          currentBranch = line.slice("branch refs/heads/".length).trim();
        }
      }
      if (currentWorktree && currentBranch === branchName) return currentWorktree;
      return undefined;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`[self-healing] reconcileCompletedTask: failed to read worktree list for ${branchName}: ${errorMessage}`);
      return undefined;
    }
  }

  protected async repoBranchExists(repoRootDir: string, branch: string): Promise<boolean> {
    try {
      await execAsync(`git rev-parse --verify ${shellQuote(`refs/heads/${branch}`)}`, {
        cwd: repoRootDir,
        timeout: 30_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  protected async readShortstatForSha(
    sha: string,
    rebaseBaseSha?: string,
  ): Promise<{ filesChanged: number; insertions: number; deletions: number } | null> {
    try {
      const command = rebaseBaseSha
        ? `git diff --shortstat ${shellQuote(`${rebaseBaseSha}..${sha}`)}`
        : `git show --shortstat --format= ${shellQuote(sha)}`;
      const stats = await execAsync(command, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
      const parsed = parseShortstat(stats.stdout);
      return {
        filesChanged: parsed.filesChanged ?? 0,
        insertions: parsed.insertions ?? 0,
        deletions: parsed.deletions ?? 0,
      };
    } catch {
      return null;
    }
  }

  protected async readLandedFilesForSha(sha: string, rebaseBaseSha?: string): Promise<string[] | null> {
    try {
      const command = rebaseBaseSha
        ? `git diff --name-only ${shellQuote(`${rebaseBaseSha}..${sha}`)}`
        : `git show --name-only --format= ${shellQuote(sha)}`;
      const result = await execAsync(command, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
      const files = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return files.length > 0 ? Array.from(new Set(files)) : [];
    } catch {
      return null;
    }
  }

  protected async isBranchTipMisboundToTask(input: {
    branch: string;
    taskId: string;
    lineageId?: string;
    baseBranch: string;
  }): Promise<{ misbound: boolean; branchTip: string; landed: Awaited<ReturnType<typeof findAlreadyMergedTaskCommit>>; rejection?: { reason: "foreign-task-tip" | "foreign-lineage-tip"; owner?: string } }> {
    const { branch, taskId, lineageId, baseBranch } = input;
    const { stdout: tipOut } = await execAsync(`git rev-parse ${shellQuote(branch)}`, {
      cwd: this.options.rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const branchTip = tipOut.trim();
    const ownership = await this.readCommitTaskOwnership(branchTip, taskId, lineageId);
    /*
    FNXC:WorkflowRecovery 2026-07-03-21:39:
    Branch-misbound recovery shares the no-op inheritance edge case with already-merged recovery. Check merge-base-to-tip diff state first so a branch with no unique task content is not mislabeled misbound solely because its inherited tip belongs to the previously landed task, even after base advances.

    FNXC:WorkflowRecovery 2026-07-25-09:40:
    Shared with already-merged recovery and the reclaim sweep via `foreignTipRejection`.
    */
    const rejection = await this.foreignTipRejection({ taskId, lineageId, branchTip, baseBranch, ownership });
    if (rejection) {
      return { misbound: false, branchTip, landed: null, rejection };
    }
    const hasTaskId = ownership.ownerTaskId === taskId;
    const hasLineage = lineageId ? ownership.ownerLineageId === lineageId : false;
    const landed = await this.findAlreadyMergedTaskCommit({
      taskId,
      lineageId,
      repoDir: this.options.rootDir,
      baseBranch,
      taskBranch: branch,
    });
    return { misbound: !hasTaskId && !hasLineage, branchTip, landed };
  }
}
