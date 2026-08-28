/**
 * FNXC:CodeOrganization 2026-08-03-17:05:
 * reviewWorkspacePerRepo peeled from TaskExecutor (U4 Slice B).
 *
 * FNXC:Workspace 2026-06-22-00:30: KTD3 — per-repo review by looping the EXISTING single-cwd reviewStep.
 * The reviewer is an AGENT spawned with `cwd = worktree`, told (in prompt text, reviewer.ts) to run `git diff`
 * itself — it does NOT read a diff passed in code. So per-repo review = ONE reviewer agent per sub-repo. We keep
 * `reviewStep` single-cwd; the CALLERS loop. This helper is the shared loop+aggregate so both review entry points
 * (historically the deleted in-session review tool, now only the step-inversion `stepReview` seam) iterate
 * identically: it invokes the caller's
 * own `invokeForCwd(cwd)` only for an explicitly scoped repository with diff evidence. Acquired
 * worktrees are never task intent: clean scoped repositories are recorded as not-reviewed and
 * out-of-scope worktrees are not opened. Modified in-scope verdicts aggregate as a conjunction.
 * verdict becomes the aggregate verdict (mirroring verifyWorktreeInvariants' first-failing-repo return), and its
 * findings are repository-qualified before they leave the loop, so aggregate evidence and per-repository
 * outcomes match the workspace task's scoped file paths. A zero-acquire workspace task is classified with the
 * completion invariant: proven commit-free work approves honestly, while unproven work returns non-retryable UNAVAILABLE.
 *
 * Verdict severity for the conjunction: any RETHINK/REVISE/UNAVAILABLE fails the whole review; only all-APPROVE
 * (or all-skipped UNAVAILABLE-advisory, handled by the caller) approves. We surface the first failing repo's exact
 * verdict so the caller's existing verdict→edge mapping (APPROVE done-marking, REVISE block, RETHINK reset,
 * UNAVAILABLE retry) is unchanged.
 */
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Settings, Task, WorkflowRepositoryReviewOutcome, WorkflowReviewFinding } from "@fusion/core";
import type { ReviewResult } from "../execution/reviewer.js";
import { captureWorkspaceReviewEvidence } from "../worktree/workspace-review-evidence.js";
import { classifyWorkspaceZeroAcquire, type WorkspaceZeroAcquireOptions } from "./workspace-zero-acquire.js";
import { captureModifiedFiles } from "./worktree-capture-modified-files.js";

const hasRepositoryPrefix = (value: string | undefined, repoRel: string, separator: "/" | ":") =>
  value === repoRel || value?.startsWith(`${repoRel}${separator}`) === true;

/*
FNXC:WorkspaceReviewFindings 2026-08-27-12:05:
FN-201 requires workspace findings to match repository-qualified File Scope and modified-file entries;
unqualified paths are scope-rejected and model-supplied finding identifiers collide across repositories.
*/
export function qualifyRepositoryFindings(repoRel: string, findings: readonly WorkflowReviewFinding[] | undefined): WorkflowReviewFinding[] | undefined {
  if (!findings?.length) return undefined;
  return findings.map((finding) => ({
    ...finding,
    id: hasRepositoryPrefix(finding.id, repoRel, ":") || hasRepositoryPrefix(finding.id, repoRel, "/")
      ? finding.id
      : `${repoRel}:${finding.id}`,
    ...(finding.filePath
      ? { filePath: hasRepositoryPrefix(finding.filePath, repoRel, "/") ? finding.filePath : `${repoRel}/${finding.filePath}` }
      : {}),
    ...(finding.rebutsDisputedFindingId
      ? {
          rebutsDisputedFindingId: hasRepositoryPrefix(finding.rebutsDisputedFindingId, repoRel, ":") || hasRepositoryPrefix(finding.rebutsDisputedFindingId, repoRel, "/")
            ? finding.rebutsDisputedFindingId
            : `${repoRel}:${finding.rebutsDisputedFindingId}`,
        }
      : {}),
  }));
}

export async function reviewWorkspacePerRepo(
  // FNXC:Workspace 2026-06-21-15:00: F7 — drop the dead `repoRel` callback param.
  // Both call sites bind `(cwd) => runForCwd(cwd)` and discard the second arg, so the type wrongly
  // implied repo identity is observable inside `runForCwd`. Removed until a real consumer needs it
  // (Phase C). The loop uses its own iteration key to qualify reviewer findings before aggregation.
  task: Task,
  invokeForCwd: (cwd: string) => Promise<ReviewResult>,
  options: Omit<WorkspaceZeroAcquireOptions, "workspaceMode"> & {
    workspaceMode?: boolean;
    workspaceRepos?: readonly string[];
    workspaceRootDir?: string;
    settings?: Partial<Settings>;
    captureModifiedFiles?: (repoRel: string, worktreePath: string, baseCommitSha?: string) => Promise<string[]>;
  } = {},
): Promise<ReviewResult> {
  const workspaceWorktrees = task.workspaceWorktrees ?? {};
  const declaredRepos = options.workspaceRepos ? new Set(options.workspaceRepos) : undefined;
  /*
  FNXC:RepositoryScope 2026-08-21-01:53:
  A proposed creation default is not review authority. Code review fails closed until the planner
  confirms repository intent, so no approval can be persisted for a scope that may be replaced.
  */
  if (task.repositoryScope?.state !== "confirmed") {
    return {
      verdict: "UNAVAILABLE",
      retryable: false,
      review: "Workspace Code Review requires a confirmed repository scope.",
      summary: "Unavailable: repository scope is not confirmed",
    };
  }
  const repositoryScope = new Set(task.repositoryScope.repositories);
  const repositoryScopeRevision = task.repositoryScope.revision;
  /*
  FNXC:RepositoryScope 2026-08-21-00:29:
  Persisted modifiedFiles is a historical task snapshot, not review authority. Re-read each
  acquired repository at the review boundary so a commit made after the last executor capture
  cannot be mislabeled clean and bypass its required approval. Diff capture is deliberately
  per-repository because workspace roots are not Git worktrees.
  */
  const repositoryDiffFingerprints: Record<string, string> = {};
  const evidence = !options.captureModifiedFiles && options.workspaceRootDir
    && Object.values(workspaceWorktrees).every((entry) => existsSync(entry.worktreePath))
    ? await captureWorkspaceReviewEvidence({ task, workspaceRootDir: options.workspaceRootDir, settings: options.settings ?? {} })
    : undefined;
  const freshModifiedFiles: string[] = evidence?.modifiedFiles ?? [];
  if (evidence) {
    for (const repository of evidence.repositories) {
      if (repository.fingerprint && repositoryScope.has(repository.repository)) {
        repositoryDiffFingerprints[repository.repository] = repository.fingerprint;
      }
    }
  } else {
    for (const repoRel of Object.keys(workspaceWorktrees).sort()) {
      const repo = workspaceWorktrees[repoRel];
      const files = await (options.captureModifiedFiles
        ? options.captureModifiedFiles(repoRel, repo.worktreePath, repo.baseCommitSha ?? undefined)
        : captureModifiedFiles(repo.worktreePath, repo.baseCommitSha ?? undefined, task.id, undefined, "workspace-review-boundary"));
      freshModifiedFiles.push(...files.map((file) => `${repoRel}/${file}`));
    }
  }
  const modifiedFiles = freshModifiedFiles;
  if (evidence && evidence.outOfScopeRepositories.size > 0) {
    return {
      verdict: "UNAVAILABLE",
      retryable: false,
      review: `Workspace Code Review cannot approve changes outside confirmed scope: ${[...evidence.outOfScopeRepositories].sort().join(", ")}.`,
      summary: `Unavailable: modified repositories outside confirmed scope: ${[...evidence.outOfScopeRepositories].sort().join(", ")}`,
      repositoryScopeRevision,
    };
  }
  const hasDiffEvidence = (repoRel: string) => modifiedFiles.some((file) => file === repoRel || file.startsWith(`${repoRel}/`));
  const seenPaths = new Set<string>();
  // FNXC:WorkspaceRootRouting 2026-08-19-12:15: Only declared repository entries are reviewable;
  // stale root-keyed metadata and duplicate paths cannot become reviewer cwd values.
  const repoKeys = Object.keys(workspaceWorktrees)
    .filter((repoRel) => {
      if (declaredRepos && !declaredRepos.has(repoRel)) return false;
      // FNXC:RepositoryScope 2026-08-20-23:07: acquisition grants a checkout, never review authority.
      if (!repositoryScope.has(repoRel) || !hasDiffEvidence(repoRel)) return false;
      const worktreePath = workspaceWorktrees[repoRel]?.worktreePath;
      if (typeof worktreePath !== "string" || worktreePath.length === 0) return false;
      const canonical = resolve(worktreePath);
      if (options.workspaceRootDir) {
        const root = resolve(options.workspaceRootDir);
        if (canonical === root || canonical.startsWith(`${root}${sep}.worktrees${sep}`)) return false;
      }
      if (seenPaths.has(canonical)) return false;
      seenPaths.add(canonical);
      return true;
    })
    .sort();
  if (repoKeys.length === 0) {
    const cleanScopedRepos = [...repositoryScope].filter((repoRel) => declaredRepos?.has(repoRel) !== false);
    if (cleanScopedRepos.length > 0 && Object.keys(workspaceWorktrees).length > 0) {
      return {
        verdict: "UNAVAILABLE",
        retryable: false,
        review: `No changes — not reviewed: ${cleanScopedRepos.map((repo) => `\`${repo}\``).join(", ")}. No scoped repository has diff evidence; this is not a blocking reviewer verdict.`,
        summary: `Not reviewed: no changes in ${cleanScopedRepos.join(", ")}`,
        repositoryModifiedFiles: modifiedFiles,
        repositoryReviewOutcomes: cleanScopedRepos.map((repository) => ({
          repository,
          status: "NOT_REVIEWED" as const,
          output: "No changes — not reviewed.",
          episodeId: new Date().toISOString(),
          scopeRevision: task.repositoryScope?.revision,
          reviewedAt: new Date().toISOString(),
        })),
        repositoryScopeRevision: task.repositoryScope?.revision,
      };
    }
    /*
    FNXC:Workspace 2026-08-15-04:21:
    This is the review-side consumer of classifyWorkspaceZeroAcquire. A proven
    commit-free task has no diff to inspect and may approve honestly; an unproven
    empty map remains unavailable, but re-invoking cannot acquire a repo, so it is
    explicitly non-retryable rather than burning the review retry budget.
    */
    const zeroAcquire = classifyWorkspaceZeroAcquire(task, {
      workspaceMode: options.workspaceMode ?? true,
      noOpCompletion: options.noOpCompletion,
      noOpCompletionReason: options.noOpCompletionReason,
    });
    if (zeroAcquire.kind === "commit-free-eligible") {
      return {
        verdict: "APPROVE",
        review: `No sub-repo worktree was acquired; no diff was reviewed because this workspace task is commit-free eligible (${zeroAcquire.reason}).`,
        summary: `APPROVE: no sub-repo worktree acquired (${zeroAcquire.reason})`,
      };
    }
    return {
      verdict: "UNAVAILABLE",
      retryable: false,
      review: "No acquired sub-repo worktree to review; re-invocation cannot change this unproven zero-acquire workspace verdict.",
      summary: "Unavailable: no sub-repo worktree acquired",
    };
  }

  // FNXC:RepositoryScope 2026-08-20-23:07: clean scoped repositories remain visible as informational non-verdicts.
  const notReviewedRepos = [...repositoryScope]
    .filter((repoRel) => declaredRepos?.has(repoRel) !== false && !hasDiffEvidence(repoRel))
    .sort();
  const reviewedAt = new Date().toISOString();
  const repositoryReviewOutcomes: WorkflowRepositoryReviewOutcome[] = notReviewedRepos.map((repository) => ({
    repository,
    status: "NOT_REVIEWED",
    output: "No changes — not reviewed.",
    episodeId: reviewedAt,
    scopeRevision: repositoryScopeRevision,
    reviewedAt,
  }));
  const reviewSections: string[] = notReviewedRepos.map((repoRel) => `### [${repoRel}] NOT_REVIEWED\nNo changes — not reviewed.`);
  const summarySections: string[] = notReviewedRepos.map((repoRel) => `[${repoRel}] NOT_REVIEWED: no changes`);
  let firstFailing: { repo: string; result: ReviewResult } | undefined;
  const findings: WorkflowReviewFinding[] = [];
  for (const repoRel of repoKeys) {
    const repo = workspaceWorktrees[repoRel];
    const result = await invokeForCwd(repo.worktreePath);
    const qualifiedFindings = qualifyRepositoryFindings(repoRel, result.findings);
    if (qualifiedFindings) findings.push(...qualifiedFindings);
    repositoryReviewOutcomes.push({
      repository: repoRel,
      status: "REVIEWED",
      verdict: result.verdict,
      output: result.review,
      ...(qualifiedFindings ? { findings: qualifiedFindings } : {}),
      fingerprint: repositoryDiffFingerprints[repoRel],
      episodeId: reviewedAt,
      scopeRevision: repositoryScopeRevision,
      reviewedAt,
    });
    // Structured findings are qualified before both durable outcomes and aggregate evidence consume them.
    reviewSections.push(`### [${repoRel}] ${result.verdict}\n${result.review}`);
    summarySections.push(`[${repoRel}] ${result.verdict}: ${result.summary}`);
    if (result.verdict !== "APPROVE") {
      // FNXC:Workspace 2026-06-21-15:00: F3 — BREAK on the first non-APPROVE repo.
      // The contract is "the FIRST non-APPROVE repo's verdict becomes the aggregate". Without the
      // break, a LATER repo's reviewer throwing would discard this already-determined REVISE/RETHINK
      // and the caller would see UNAVAILABLE — masking the real verdict. Stop at the first failure.
      firstFailing = { repo: repoRel, result };
      break;
    }
  }

  if (firstFailing) {
    // Conjunction failed: the aggregate carries the FIRST failing repo's verdict (so the caller's
    // verdict→edge mapping is identical to single-cwd), with the full repo-tagged review body.
    return {
      verdict: firstFailing.result.verdict,
      // FNXC:Workspace 2026-06-22-00:00: the conjunction BREAKS on the first non-APPROVE repo,
      // so reviewSections holds only the repos evaluated up to (and including) the failure — not
      // every sub-repo. Label it honestly so operators don't read a partial list as exhaustive.
      review: `Workspace review failed in sub-repo \`${firstFailing.repo}\` (verdict ${firstFailing.result.verdict}). Per-repo verdicts (evaluation stopped at first failure; later modified repos not reviewed):\n\n${reviewSections.join("\n\n")}`,
      summary: `${firstFailing.repo}: ${firstFailing.result.verdict} — ${summarySections.join(" | ")}`,
      repositoryDiffFingerprints,
      repositoryModifiedFiles: modifiedFiles,
      repositoryReviewOutcomes,
      ...(findings.length > 0 ? { findings } : {}),
      repositoryScopeRevision: repositoryScopeRevision,
    };
  }

  // Every sub-repo approved → the task is reviewed (conjunction satisfied).
  return {
    verdict: "APPROVE",
    review: `All ${repoKeys.length} modified in-scope sub-repo(s) approved. Per-repo outcomes:\n\n${reviewSections.join("\n\n")}`,
    summary: `APPROVE across ${repoKeys.length} modified in-scope sub-repo(s): ${summarySections.join(" | ")}`,
    repositoryDiffFingerprints,
    repositoryModifiedFiles: modifiedFiles,
    repositoryReviewOutcomes,
    ...(findings.length > 0 ? { findings } : {}),
    repositoryScopeRevision: repositoryScopeRevision,
  };
}
