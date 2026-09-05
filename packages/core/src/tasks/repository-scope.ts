import type { Task } from "../types.js";

/*
FNXC:RepositoryScope 2026-08-24-06:11:
ONE definition of "this task's repository review evidence is load-bearing". Landing evaluates its
approval fence only for this shape (a recorded evidence map, or an enabled step matching /review/i);
a legacy or direct caller with neither retains the merge-agent review path. The workspace
late-acquire gate admits a review-column task only for the same shape (KTD6a), because for the other
one BOTH halves of the mitigation are absent at once and a new repository would land unreviewed. Two
copies of that condition can drift into exactly that hole, so both callers read this predicate.
*/
export function requiresRepositoryReviewEvidence(
  task: Pick<Task, "repositoryScope" | "enabledWorkflowSteps">,
): boolean {
  if (task.repositoryScope?.reviewEvidence !== undefined) return true;
  return (task.enabledWorkflowSteps ?? []).some((step) => /review/i.test(step));
}

/**
 * FNXC:RepositoryScope 2026-08-21-03:05:
 * A repository-scope revision invalidates Code Review results from every older generation.
 * Keep an explicit failed record rather than deleting it: absence could accidentally satisfy a
 * merge gate, while the diagnostic prevents an old approval from admitting a graph edge.
 */
export function invalidateSupersededRepositoryScopeReviews(
  results: Task["workflowStepResults"],
  revision: number | undefined,
): Task["workflowStepResults"] {
  if (revision === undefined) return results;
  return results?.map((result) => (
    result.reviewKind === "code"
      && typeof result.repositoryScopeRevision === "number"
      && result.repositoryScopeRevision !== revision
      ? {
          ...result,
          status: "failed" as const,
          verdict: undefined,
          findings: undefined,
          repositoryReviewOutcomes: undefined,
          output: "Code Review result superseded by a repository scope change.",
          notes: undefined,
        }
      : result
  ));
}
