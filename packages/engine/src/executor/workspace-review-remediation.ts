import type { Task, WorkflowStepResult } from "@fusion/core";

function normalize(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export type WorkspaceReviewRemediation = NonNullable<NonNullable<Task["repositoryScope"]>["reviewRemediation"]>;

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
 * rendered feedback or a singular task worktree. This makes an empty-finding REVISE convergent and
 * keeps the next executor in the repository that actually failed review.
 */
export function deriveWorkspaceReviewRemediation(
  result: Pick<WorkflowStepResult, "workflowStepId" | "repositoryScopeRevision" | "repositoryReviewOutcomes">,
): WorkspaceReviewRemediation | undefined {
  if (typeof result.repositoryScopeRevision !== "number") return undefined;
  const blocking = (result.repositoryReviewOutcomes ?? [])
    .filter((outcome) => outcome.status === "REVIEWED" && (outcome.verdict === "REVISE" || outcome.verdict === "RETHINK"))
    .sort((left, right) => left.repository.localeCompare(right.repository))[0];
  if (!blocking) return undefined;
  /*
  FNXC:WorkspaceReviewConvergence 2026-08-27-12:05:
  FN-201 makes workspace findings non-empty. Identifier-based signatures would let a model-assigned
  ID change defeat the repeat-unchanged hold and turn bounded remediation into an unbounded loop.
  */
  const findings = (blocking.findings ?? [])
    .map((finding) => `${normalize(finding.filePath)}:${finding.line ?? ""}:${normalize(finding.body)}`)
    .sort()
    .join("|");
  return {
    scopeRevision: result.repositoryScopeRevision,
    repository: blocking.repository,
    inputSignature: `${result.workflowStepId}\u0000${blocking.repository}\u0000${blocking.fingerprint ?? ""}\u0000${blocking.verdict}\u0000${findings}`,
  };
}
