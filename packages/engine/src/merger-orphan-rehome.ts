/**
 * Orphan-our-advance classification + fast-forward rehome.
 *
 * Catches the post-fix tail of the non-FF ref-advance bug fixed in
 * `merger-ref-update-advance.ts`: a squash commit produced by the merger
 * that *was* the integration tip at one point but is now reachable only
 * from a downstream feature branch (because a sibling merger advanced the
 * ref off a stale base before the FF-only invariant was enforced).
 *
 * Recovery scope is intentionally narrow:
 *   - FF rehome only — advance `refs/heads/<integrationBranch>` to the
 *     orphan when the integration tip is an ancestor of the orphan.
 *   - Non-FF (sibling) orphans are *detected and logged* with an
 *     actionable hint, but not auto-rehomed: a cherry-pick mutates the
 *     integration branch with content that may conflict, and that's a
 *     blast radius we don't want inside automated recovery.
 *
 * Strictness gates:
 *   - The commit's Fusion-Task-Id trailer must resolve to a task whose
 *     column is `done` (the merger logged success).
 *   - The commit must NOT already be reachable from the integration ref
 *     (otherwise it's `already-upstream` and the existing classifier
 *     handles it).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskStore } from "@fusion/core";
import type { RunAuditor } from "./run-audit.js";
import {
  advanceIntegrationBranchRef,
} from "./merger-ref-update-advance.js";

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return stdout;
}

async function isAncestor(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      { cwd: repoDir, encoding: "utf-8", timeout: 30_000 },
    );
    return true;
  } catch {
    return false;
  }
}

export type OrphanClassification =
  | { orphan: true; sourceTaskId: string; orphanSha: string }
  | {
    orphan: false;
    reason:
      | "no-trailer"
      | "source-task-not-found"
      | "source-task-not-done"
      | "reachable-from-integration"
      | "self-attributed";
  };

export interface ClassifyOrphanOurAdvanceInput {
  repoDir: string;
  taskStore: TaskStore;
  integrationBranch: string;
  currentTaskId: string;
  commitSha: string;
  commitSubject: string;
  commitBody: string;
}

export async function classifyOrphanOurAdvance(
  input: ClassifyOrphanOurAdvanceInput,
): Promise<OrphanClassification> {
  const subjectPattern = /^(feat|fix|test|chore|docs|refactor|perf|build)\((FN-\d+)\):/i;
  const trailerPattern = /(?:^|\n)Fusion-Task-Id:\s*(FN-\d+)\s*(?:\n|$)/i;
  const subjectMatch = input.commitSubject.match(subjectPattern);
  const trailerMatch = input.commitBody.match(trailerPattern);
  const sourceTaskId = (trailerMatch?.[1] ?? subjectMatch?.[2] ?? "").toUpperCase();
  if (!sourceTaskId) return { orphan: false, reason: "no-trailer" };
  if (sourceTaskId === input.currentTaskId.toUpperCase()) {
    return { orphan: false, reason: "self-attributed" };
  }

  const sourceTask = await input.taskStore.getTask(sourceTaskId);
  if (!sourceTask) return { orphan: false, reason: "source-task-not-found" };
  if (sourceTask.column !== "done") return { orphan: false, reason: "source-task-not-done" };

  const integrationRef = `refs/heads/${input.integrationBranch}`;
  if (await isAncestor(input.repoDir, input.commitSha, integrationRef)) {
    return { orphan: false, reason: "reachable-from-integration" };
  }

  return { orphan: true, sourceTaskId, orphanSha: input.commitSha };
}

export type RehomeOutcome =
  | { rehomed: true; mode: "fast-forward"; previousTipSha: string; newTipSha: string }
  | {
    rehomed: false;
    mode: "refused-non-fast-forward" | "advance-refused";
    reason: string;
    integrationTipSha: string;
    cherryPickHint?: string;
  };

export interface RehomeOrphanOntoIntegrationInput {
  rootDir: string;
  projectRootDir: string;
  integrationBranch: string;
  orphanSha: string;
  taskId: string;
  audit: RunAuditor;
}

/**
 * Attempt to rehome an orphan-our-advance commit onto the integration
 * branch via fast-forward only. Non-FF orphans return
 * `mode: "refused-non-fast-forward"` with a `cherryPickHint` the caller
 * should log so an operator can rehome manually.
 */
export async function rehomeOrphanOntoIntegration(
  input: RehomeOrphanOntoIntegrationInput,
): Promise<RehomeOutcome> {
  const integrationRef = `refs/heads/${input.integrationBranch}`;
  const integrationTipSha = (await runGit(["rev-parse", "--verify", integrationRef], input.rootDir)).trim();

  // Fast-forward is possible iff the integration tip is an ancestor of the
  // orphan (i.e., the orphan extends the integration branch by one or
  // more commits).
  if (!(await isAncestor(input.rootDir, integrationTipSha, input.orphanSha))) {
    const hint = `git -C ${input.projectRootDir} cherry-pick ${input.orphanSha}`;
    await input.audit.git({
      type: "merger:orphan-rehome-refused",
      target: input.integrationBranch,
      metadata: {
        taskId: input.taskId,
        integrationBranch: input.integrationBranch,
        orphanSha: input.orphanSha,
        integrationTipSha,
        reason: "non-fast-forward",
        cherryPickHint: hint,
      },
    });
    return {
      rehomed: false,
      mode: "refused-non-fast-forward",
      reason: `orphan ${input.orphanSha} diverges from integration tip ${integrationTipSha}; manual cherry-pick required`,
      integrationTipSha,
      cherryPickHint: hint,
    };
  }

  const advanceResult = await advanceIntegrationBranchRef({
    rootDir: input.rootDir,
    projectRootDir: input.projectRootDir,
    integrationBranch: input.integrationBranch,
    newSha: input.orphanSha,
    expectedCurrentSha: integrationTipSha,
    taskId: input.taskId,
    audit: input.audit,
  });

  if (!advanceResult.advanced) {
    return {
      rehomed: false,
      mode: "advance-refused",
      reason: `${advanceResult.reason}: ${advanceResult.diagnostic}`,
      integrationTipSha,
    };
  }

  await input.audit.git({
    type: "merger:orphan-rehome-ff",
    target: input.integrationBranch,
    metadata: {
      taskId: input.taskId,
      integrationBranch: input.integrationBranch,
      orphanSha: input.orphanSha,
      previousTipSha: advanceResult.previousSha,
      newTipSha: advanceResult.newSha,
    },
  });

  return {
    rehomed: true,
    mode: "fast-forward",
    previousTipSha: advanceResult.previousSha,
    newTipSha: advanceResult.newSha,
  };
}
