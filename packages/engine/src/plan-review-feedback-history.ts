const PLAN_REVIEW_REVISION_SOURCE_MARKER = "Revision source: plan-review/";
const LEGACY_PLAN_REVIEW_FEEDBACK_PREFIX = "Plan Review requested a planning revision before execution.";

type ReviewResultLike = {
  workflowStepId?: string;
  workflowStepName?: string;
  verdict?: string;
  status?: string;
  output?: string;
  notes?: string;
  supersededAt?: string;
  priorAttempts?: ReviewResultLike[];
};

type RevisionLogEntry = {
  action?: string;
  outcome?: string;
};

/** Retain decisions through the default unbounded-review safety ceiling. */
export const PLAN_REVIEW_FEEDBACK_HISTORY_LIMIT = 15;

function normalizeRevisionKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function feedbackText(result: ReviewResultLike): string | undefined {
  const text = result.notes?.trim() || result.output?.trim();
  return text || undefined;
}

function isPlanReviewRevision(result: ReviewResultLike): boolean {
  return result.verdict === "REVISE";
}

function sameEpisodeRevisionAttempts(
  result: ReviewResultLike,
  includeCurrent: boolean,
): ReviewResultLike[] {
  const newestFirst: ReviewResultLike[] = [];
  for (const attempt of result.priorAttempts ?? []) {
    // Dependency invalidation marks the prior episode's surviving projection.
    // It and every older snapshot belong to the superseded episode.
    if (attempt.supersededAt) break;
    if (isPlanReviewRevision(attempt)) newestFirst.push(attempt);
  }
  const oldestFirst = newestFirst.reverse();
  if (includeCurrent && isPlanReviewRevision(result)) oldestFirst.push(result);
  return oldestFirst;
}

function matchesPlanReviewResult(result: ReviewResultLike, requestedKey: string): boolean {
  const resultKey = normalizeRevisionKey(result.workflowStepId);
  const isNamedPlanReview = normalizeRevisionKey(result.workflowStepName) === "plan review";
  return requestedKey ? resultKey === requestedKey : isNamedPlanReview || resultKey === "plan-review";
}

export function formatPlanReviewRevisionFeedback(revisionKey: string, status: string, feedback: string): string {
  return `${PLAN_REVIEW_REVISION_SOURCE_MARKER}${revisionKey}\n${LEGACY_PLAN_REVIEW_FEEDBACK_PREFIX}\n\nStatus: ${status}\nFeedback:\n${feedback}`;
}

export function isPlanReviewRevisionLog(entry: RevisionLogEntry): boolean {
  const outcome = entry.outcome?.trim() ?? "";
  return entry.action === "AI spec revision requested"
    && (outcome.startsWith(PLAN_REVIEW_REVISION_SOURCE_MARKER) || outcome.startsWith(LEGACY_PLAN_REVIEW_FEEDBACK_PREFIX));
}

/**
 * Read full, bounded Plan Review history from workflow-step results.
 * `priorAttempts` is already capped by upsertWorkflowStepResult and is not
 * subject to the activity log's 4,000-character preview truncation.
 */
export function collectPlanReviewFeedbackHistory(
  results: ReviewResultLike[] | undefined,
  options: { revisionKey?: string; exclude?: string; includeCurrent?: boolean } = {},
): string[] {
  const requestedKey = normalizeRevisionKey(options.revisionKey);
  const excluded = options.exclude?.trim();
  const seen = new Set<string>();
  const history: string[] = [];

  for (const result of results ?? []) {
    if (result.supersededAt) continue;
    if (!matchesPlanReviewResult(result, requestedKey)) continue;

    for (const attempt of sameEpisodeRevisionAttempts(result, options.includeCurrent !== false)) {
      const feedback = feedbackText(attempt);
      if (!feedback || feedback === excluded || seen.has(feedback)) continue;
      seen.add(feedback);
      history.push(feedback);
    }
  }

  return history;
}

/** Count every same-episode REVISE attempt; unlike rendering, duplicates count. */
export function countPlanReviewRevisionAttempts(
  results: ReviewResultLike[] | undefined,
  options: { revisionKey?: string; includeCurrent?: boolean } = {},
): number {
  const requestedKey = normalizeRevisionKey(options.revisionKey);
  let count = 0;
  for (const result of results ?? []) {
    if (result.supersededAt || !matchesPlanReviewResult(result, requestedKey)) continue;
    count += sameEpisodeRevisionAttempts(result, options.includeCurrent !== false).length;
  }
  return count;
}
