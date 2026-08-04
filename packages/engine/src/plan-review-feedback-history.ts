const PLAN_REVIEW_REVISION_SOURCE_MARKER = "Revision source: plan-review/";
const LEGACY_PLAN_REVIEW_FEEDBACK_PREFIX = "Plan Review requested a planning revision before execution.";

type ReviewResultLike = {
  workflowStepId?: string;
  workflowStepName?: string;
  verdict?: string;
  status?: string;
  output?: string;
  notes?: string;
  startedAt?: string;
  supersededAt?: string;
  planReviewAttemptCount?: number;
  priorAttempts?: ReviewResultLike[];
};

type RevisionLogEntry = {
  action?: string;
  outcome?: string;
};

// FNXC:PlanReviewConvergence 2026-08-04-06:35 (FN-8768): Prompt history is
// bounded independently of persistence and retry accounting. Persisted attempts
// remain the raw budget ledger; only reviewer-facing prose is capped here.
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

/*
 * FNXC:PlanReviewConvergence 2026-08-04-06:35 (FN-8768):
 * `priorAttempts` is persisted newest-first, so reverse the retained slice for
 * chronological rendering. A superseded attempt is the planning-episode
 * boundary: it and every older snapshot are excluded from both prose and count.
 */
function sameEpisodeRevisionAttempts(
  result: ReviewResultLike,
  includeCurrent: boolean,
): ReviewResultLike[] {
  const newestFirst: ReviewResultLike[] = [];
  for (const attempt of result.priorAttempts ?? []) {
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

/** Read same-episode Plan Review decisions for a bounded reviewer prompt. */
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

  return history.slice(-PLAN_REVIEW_FEEDBACK_HISTORY_LIMIT);
}

// FNXC:PlanReviewConvergence 2026-08-04-06:35 (FN-8768): Do not reuse the
// rendering cap here. Revision admission must count every same-episode REVISE,
// including duplicate prose, or attempts beyond the prompt window evade budgets.
export function countPlanReviewRevisionAttempts(
  results: ReviewResultLike[] | undefined,
  options: { revisionKey?: string; includeCurrent?: boolean } = {},
): number {
  const requestedKey = normalizeRevisionKey(options.revisionKey);
  let count = 0;
  for (const result of results ?? []) {
    if (result.supersededAt || !matchesPlanReviewResult(result, requestedKey)) continue;
    const persistedCount = result.planReviewAttemptCount;
    if (typeof persistedCount === "number" && Number.isInteger(persistedCount) && persistedCount >= 0) {
      const excludesCurrentRevision = options.includeCurrent === false && isPlanReviewRevision(result);
      count += Math.max(0, persistedCount - (excludesCurrentRevision ? 1 : 0));
      continue;
    }
    count += sameEpisodeRevisionAttempts(result, options.includeCurrent !== false).length;
  }
  return count;
}

/*
 * FNXC:PlanReviewConvergence 2026-08-04-06:35 (FN-8768):
 * Advance the durable Plan Review counter while a result is upserted.
 * A pending result carries the completed-revision count forward; its terminal
 * REVISE transition increments once. Repeated writes for the same terminal
 * attempt are idempotent, and a superseded projection starts a new episode.
 */
export function nextPlanReviewAttemptCount(
  previous: ReviewResultLike | undefined,
  incoming: ReviewResultLike,
): number {
  const sameAttempt = previous?.startedAt !== undefined
    && incoming.startedAt !== undefined
    && previous.startedAt === incoming.startedAt;
  const previousCount = previous?.supersededAt
    ? 0
    : countPlanReviewRevisionAttempts(previous ? [previous] : undefined);

  if (!isPlanReviewRevision(incoming)) return previousCount;
  if (sameAttempt && previous && isPlanReviewRevision(previous)) return previousCount;
  return previousCount + 1;
}
