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
 * out-of-scope worktrees are not opened. Findings are repository-qualified before they leave the
 * loop, so aggregate evidence and per-repository outcomes match the workspace task's scoped file
 * paths. A zero-acquire workspace task is classified with the completion invariant: proven
 * commit-free work approves honestly, while unproven work returns non-retryable UNAVAILABLE.
 *
 * FNXC:WorkspaceReviewCoverage 2026-08-28-11:50:
 * FN-223 requires one complete workspace verdict. Every modified in-scope repository is reviewed
 * before aggregation, and deterministic severity (`RETHINK` > `REVISE` > `UNAVAILABLE` > approval)
 * ensures iteration order cannot hide a stronger blocker. Approval-with-notes remains visible in
 * its repository outcome while the approval-family aggregate is normalized to `APPROVE`.
 */
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Settings, Task, WorkflowRepositoryReviewOutcome, WorkflowReviewFinding } from "@fusion/core";
import type { ReviewResult } from "../execution/reviewer.js";
import { captureWorkspaceReviewEvidence } from "../worktree/workspace-review-evidence.js";
import { isFastForwardAdvance } from "../worktree/review-inline-fix-recapture.js";
import { classifyWorkspaceZeroAcquire, type WorkspaceZeroAcquireOptions } from "./workspace-zero-acquire.js";
import { captureModifiedFiles } from "./worktree-capture-modified-files.js";

const hasRepositoryPrefix = (value: string | undefined, repoRel: string, separator: "/" | ":") =>
  value === repoRel || value?.startsWith(`${repoRel}${separator}`) === true;

/*
FNXC:WorkspaceReviewCoverage 2026-08-28-11:50:
Prompt and custom review severity gates may return `APPROVE_WITH_NOTES`. It is an approving verdict,
so treating it as blocking would truncate complete workspace coverage and withhold merge evidence.
*/
export function isApprovalFamilyVerdict(verdict: string | undefined): boolean {
  return verdict === "APPROVE" || verdict === "APPROVE_WITH_NOTES";
}

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
  const reviewedResults: Array<{ repository: string; result: ReviewResult }> = [];
  const noVerdictRepositories: string[] = [];
  const findings: WorkflowReviewFinding[] = [];
  for (const repoRel of repoKeys) {
    const repo = workspaceWorktrees[repoRel];
    let result: ReviewResult;
    try {
      result = await invokeForCwd(repo.worktreePath);
    } catch (error) {
      /*
      FNXC:WorkspaceReviewCoverage 2026-08-28-11:50:
      FN-223 isolates ordinary repository reviewer failures as `UNAVAILABLE`, below an already-known
      `REVISE` or `RETHINK`, so one failed reviewer cannot erase determined findings. A provider
      usage-limit or transient failure is not a verdict: abort without invoking remaining repositories
      or publishing partial findings, then rethrow. The stepReview seam's existing blanket handler
      converts that throw to narrated `UNAVAILABLE`, and its bounded retry reruns the whole episode.
      */
      if (error instanceof Error && error.name === "ReviewerProviderError") throw error;
      const message = error instanceof Error ? error.message : String(error);
      noVerdictRepositories.push(repoRel);
      result = {
        verdict: "UNAVAILABLE",
        review: `reviewer error: ${message}`,
        summary: `reviewer error: ${message}`,
      };
    }
    reviewedResults.push({ repository: repoRel, result });
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
  }

  /*
  FNXC:WorkspaceReviewCoverage 2026-08-28-11:50:
  FN-223 aggregates only after the complete walk. Strongest-severity selection preserves every
  repository's findings while making the result independent of alphabetical iteration order.
  */
  const aggregateVerdict: ReviewResult["verdict"] = reviewedResults.some(({ result }) => result.verdict === "RETHINK")
    ? "RETHINK"
    : reviewedResults.some(({ result }) => result.verdict === "REVISE")
      ? "REVISE"
      : reviewedResults.some(({ result }) => !isApprovalFamilyVerdict(result.verdict))
        ? "UNAVAILABLE"
        : "APPROVE";
  /*
  FNXC:PreMergeApproval 2026-09-01-06:53:
  FN-9234 fixes the same pre-dispatch-capture defect for workspace review evidence. Each repository
  may advance only when its own reviewer finished on a proven fast-forward; workspace re-entry already
  owns stale evidence, so this producer never applies the singular reroute.
  */
  let publishedModifiedFiles = modifiedFiles;
  if (isApprovalFamilyVerdict(aggregateVerdict) && evidence && options.workspaceRootDir) {
    try {
      const refreshed = await captureWorkspaceReviewEvidence({ task, workspaceRootDir: options.workspaceRootDir, settings: options.settings ?? {} });
      if (refreshed.outOfScopeRepositories.size > 0) {
        return { verdict: "UNAVAILABLE", retryable: false, review: "Workspace Code Review cannot approve changes outside confirmed scope after review.", summary: "Unavailable: changes outside confirmed scope after review", repositoryScopeRevision };
      }
      for (const updated of refreshed.repositories) {
        const original = evidence.repositories.find((candidate) => candidate.repository === updated.repository);
        const worktreePath = workspaceWorktrees[updated.repository]?.worktreePath;
        const outcome = repositoryReviewOutcomes.find((candidate) => candidate.repository === updated.repository && candidate.status === "REVIEWED");
        /*
        FNXC:PreMergeApproval 2026-09-01-07:46:
        Only a repository whose own reviewer ran may re-bind. A clean repository can become dirty
        while another repository is being reviewed, but it has no lane that inspected that tree and
        must remain missing at the merge gate.
        */
        if (!original || !worktreePath || !updated.fingerprint || !outcome || !repositoryScope.has(updated.repository)) continue;
        if (await isFastForwardAdvance(worktreePath, original.branch, updated.branch)) {
          repositoryDiffFingerprints[updated.repository] = updated.fingerprint;
          outcome.fingerprint = updated.fingerprint;
        }
      }
      publishedModifiedFiles = refreshed.modifiedFiles;
    } catch {
      // Keep pre-review evidence on unreadable post-review Git state so landing fails closed.
    }
  }
  const blockingRepositories = reviewedResults
    .filter(({ result }) => !isApprovalFamilyVerdict(result.verdict))
    .map(({ repository }) => repository);
  const blockingSummary = blockingRepositories.length > 0
    ? `blocking repositories: ${blockingRepositories.join(", ")}`
    : `all ${repoKeys.length} modified in-scope repositories approved`;
  const coverageNotice = noVerdictRepositories.length > 0
    ? `\nNot covered by a verdict: ${noVerdictRepositories.join(", ")}.`
    : "";

  return {
    verdict: aggregateVerdict,
    review: `All ${repoKeys.length} modified in-scope sub-repository review(s) were evaluated. Aggregate verdict: ${aggregateVerdict}. ${blockingRepositories.length > 0 ? `Blocking repositories: ${blockingRepositories.join(", ")}.` : "No blocking repositories."}${coverageNotice} Per-repository outcomes:\n\n${reviewSections.join("\n\n")}`,
    summary: `${aggregateVerdict} — ${blockingSummary} — ${summarySections.join(" | ")}`,
    repositoryDiffFingerprints,
    repositoryModifiedFiles: publishedModifiedFiles,
    repositoryReviewOutcomes,
    ...(findings.length > 0 ? { findings } : {}),
    repositoryScopeRevision: repositoryScopeRevision,
  };
}
