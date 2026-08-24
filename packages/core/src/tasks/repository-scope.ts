import type { Task } from "../types.js";

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
