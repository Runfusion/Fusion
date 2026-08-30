import { isActionableReviewFinding, type Task, type WorkflowStepResult } from "@fusion/core";

function normalize(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export type WorkspaceReviewRemediation = NonNullable<NonNullable<Task["repositoryScope"]>["reviewRemediation"]>;

export function hasDurableRepeatedWorkspaceReview(
  task: Pick<Task, "repositoryScope">,
  remediation: WorkspaceReviewRemediation | undefined,
): boolean {
  const prior = task.repositoryScope?.reviewRemediation;
  return remediation !== undefined
    && prior?.scopeRevision === remediation.scopeRevision
    && prior.repository === remediation.repository
    && prior.inputSignature === remediation.inputSignature;
}

/**
 * FNXC:WorkspaceFinalization 2026-08-21-09:33:
 * The remediation record is a scope-generation fence, not a coordinator preference. Reject a
 * changed, foreign, or unconfirmed target before acquisition so a later repository REVISE cannot
 * silently run from the first checkout after a restart.
 */
export function resolveWorkspaceReviewRemediationRepository(
  task: Pick<Task, "id" | "repositoryScope">,
  declaredRepositories: readonly string[],
): string | undefined {
  const scope = task.repositoryScope;
  const remediation = scope?.reviewRemediation;
  if (!remediation) return undefined;
  if (scope?.state !== "confirmed" || scope.revision !== remediation.scopeRevision) {
    throw new Error(`Workspace Code Review remediation target is stale for ${task.id}`);
  }
  if (!declaredRepositories.includes(remediation.repository)) {
    throw new Error(`Workspace Code Review remediation repository ${remediation.repository} is not declared for ${task.id}`);
  }
  return remediation.repository;
}

/**
 * FNXC:WorkspaceFinalization 2026-08-21-09:09:
 * A workspace remediation target is derived from structured per-repository review evidence, never
 * rendered feedback or a singular task worktree. A repository rejection is blocking only when it
 * carries actionable findings, so an empty-finding REVISE remains advisory and cannot select a
 * remediation target. The next executor stays in the alphabetically first repository that failed
 * review, while the convergence signature covers every blocking repository in the same episode.
 */
export function deriveWorkspaceReviewRemediation(
  result: Pick<WorkflowStepResult, "workflowStepId" | "repositoryScopeRevision" | "repositoryReviewOutcomes">,
): WorkspaceReviewRemediation | undefined {
  if (typeof result.repositoryScopeRevision !== "number") return undefined;
  const blocking = (result.repositoryReviewOutcomes ?? [])
    .filter((outcome) => outcome.status === "REVIEWED"
      && (outcome.verdict === "REVISE" || outcome.verdict === "RETHINK")
      && (outcome.findings ?? []).some(isActionableReviewFinding))
    .sort((left, right) => left.repository.localeCompare(right.repository));
  if (blocking.length === 0) return undefined;
  /*
  FNXC:WorkspaceReviewConvergence 2026-08-28-11:50:
  FN-223 requires repeat-unchanged detection to span every blocking repository. Otherwise an
  unchanged alphabetically first repository could hide changed findings in a later repository.
  The deterministic digest matches reviewInputSignature and excludes volatile model finding IDs.
  */
  const blockingSignatures = blocking.map((outcome) => {
    const findings = (outcome.findings ?? [])
      .map((finding) => `${normalize(finding.filePath)}:${finding.line ?? ""}:${normalize(finding.body)}`)
      .sort()
      .join("|");
    return `${outcome.repository}\u0000${outcome.fingerprint ?? ""}\u0000${outcome.verdict}\u0000${findings}`;
  });
  return {
    scopeRevision: result.repositoryScopeRevision,
    repository: blocking[0].repository,
    inputSignature: `${result.workflowStepId}\u0000${result.repositoryScopeRevision}\u0000${blockingSignatures.join("\u0001")}`,
  };
}
