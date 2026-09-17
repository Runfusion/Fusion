/*
FNXC:TaskSearch 2026-09-17-09:41:
FN-477 gives the header search two distinct lanes: a paginated literal/lexical text lane owned by
`GET /tasks/page`, and an explicit AI lane owned by `POST /ai/search-tasks` that only runs when the
operator presses Enter. This module is the ONE contract both the browser client and the Express
service import, so limits, error codes, and the response shape cannot drift between them.

It must stay browser-safe: no `node:` imports, no Express types, no store types. Only plain data.
*/

/** Trimmed query bounds accepted by the AI search route. Rejected before any session is created. */
export const AI_TASK_SEARCH_MIN_QUERY_LENGTH = 1;
export const AI_TASK_SEARCH_MAX_QUERY_LENGTH = 1000;

/** The model selects at most this many tasks. Fewer is valid; padding with arbitrary rows is not. */
export const AI_TASK_SEARCH_RESULT_LIMIT = 5;

/** At most this many query expansions are derived from the operator phrase in the first turn. */
export const AI_TASK_SEARCH_MAX_EXPANSIONS = 4;

/** Per-expansion store read bound. The corpus is the whole project, never the browser collection. */
export const AI_TASK_SEARCH_CANDIDATE_PAGE_LIMIT = 50;

/** Deterministic upper bound on the candidate set handed to the ranking turn. */
export const AI_TASK_SEARCH_MAX_CANDIDATES = 100;

/** Hard ceiling on the serialized ranking context, including JSON escaping. */
export const AI_TASK_SEARCH_MAX_CONTEXT_CHARS = 48_000;

/** Dedicated per (project, IP) budget. Deliberately separate from the 10/hour helper limiter. */
export const AI_TASK_SEARCH_MAX_REQUESTS_PER_HOUR = 60;
export const AI_TASK_SEARCH_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Concurrency reservations. These never consume a task-execution slot. */
export const AI_TASK_SEARCH_MAX_CONCURRENT_PER_PROJECT = 2;
export const AI_TASK_SEARCH_MAX_CONCURRENT_PER_PROCESS = 4;

/**
 * Generation budget. Must stay below the 30s remote-node proxy timeout so a proxied search fails
 * with this service's stable code rather than an opaque gateway timeout.
 */
export const AI_TASK_SEARCH_GENERATION_TIMEOUT_MS = 25_000;

/** Extra grace for bounded teardown after the generation budget elapses. */
export const AI_TASK_SEARCH_CLEANUP_GRACE_MS = 1_000;

/** Client-side ceiling; below the proxy timeout and above the server budget. */
export const AI_TASK_SEARCH_CLIENT_TIMEOUT_MS = 28_000;

/** Remote-node proxy timeout for the AI search POST. */
export const AI_TASK_SEARCH_PROXY_TIMEOUT_MS = 30_000;

/** Text-lane page size owned by the header search collection. */
export const TASK_SEARCH_TEXT_PAGE_LIMIT = 50;

/** Debounce before the text lane issues a request for a newly typed query. */
export const TASK_SEARCH_TEXT_DEBOUNCE_MS = 200;

/**
 * Stable machine-readable failure codes. The browser maps these to recovery copy; provider prose is
 * deliberately never forwarded, so an operator sees an actionable state and never a raw model error.
 */
export const AI_TASK_SEARCH_ERROR_CODES = {
  /** Query missing, blank after trim, or outside the accepted length bounds. No session was created. */
  validation: "AI_TASK_SEARCH_VALIDATION_ERROR",
  /** Dedicated hourly budget or concurrency reservation exhausted. No session was created. */
  rateLimited: "AI_TASK_SEARCH_RATE_LIMIT",
  /** No complete Fast & Cheap provider/model pair resolved, or the runtime refused the session. */
  unavailable: "AI_TASK_SEARCH_SERVICE_UNAVAILABLE",
  /** The model answered, but the answer was unparseable or contained no candidate-set task. */
  invalidModelResponse: "AI_TASK_SEARCH_INVALID_MODEL_RESPONSE",
  /** The generation budget elapsed or the request was aborted upstream. */
  timeout: "AI_TASK_SEARCH_TIMEOUT",
} as const;

export type AiTaskSearchErrorCode =
  (typeof AI_TASK_SEARCH_ERROR_CODES)[keyof typeof AI_TASK_SEARCH_ERROR_CODES];

export interface AiTaskSearchRequestBody {
  query: string;
}

/**
 * Response shape. `query` echoes the exact trimmed phrase the selection belongs to so a late
 * response can be fenced by the browser against the field's current value.
 */
export interface AiTaskSearchResponse<TTask = unknown> {
  query: string;
  tasks: TTask[];
}

export interface NormalizedAiTaskSearchQuery {
  query: string;
}

export class AiTaskSearchValidationError extends Error {
  readonly code = AI_TASK_SEARCH_ERROR_CODES.validation;
  constructor(message = "Invalid task search query") {
    super(message);
    this.name = "AiTaskSearchValidationError";
  }
}

/**
 * Validate and normalize the request body. Runs BEFORE capacity reservation and before any session
 * exists, so a malformed request can never cost a model call or a rate-limit slot.
 */
export function normalizeAiTaskSearchQuery(body: unknown): NormalizedAiTaskSearchQuery {
  const raw = (body as { query?: unknown } | null | undefined)?.query;
  if (typeof raw !== "string") throw new AiTaskSearchValidationError();
  const query = raw.trim();
  if (query.length < AI_TASK_SEARCH_MIN_QUERY_LENGTH) throw new AiTaskSearchValidationError();
  if (query.length > AI_TASK_SEARCH_MAX_QUERY_LENGTH) throw new AiTaskSearchValidationError();
  return { query };
}
