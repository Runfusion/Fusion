/*
FNXC:SharedStoreErrorShape 2026-09-23-06:00:
STAS-251. During the 2026-09-23 stall one database held every task but the pool could not
answer, and the tools turned that into two kinds of lie: "Task STAS-250 not found" for a card
that was alive (an agent rebuilt it), and "Step 7 → done" for a transition the store had
refused. Both read as successes because `AgentLogger` records `tool_error` only when a result
carries `isError`. Every tool that learns the store — not its data — stopped it now returns
one of these two results, so the agent can tell a card that is absent from a board it cannot
reach, and a step it closed from one it merely asked about.
*/

/** A step transition the store holds the authority to refuse, and what to do next. */
export const STEP_LIFECYCLE_GUIDANCE =
  "Nothing was persisted. A step moves pending → in-progress → done one transition at a time and never backwards; " +
  "find the step the frontier is actually on, move that one, and retry.";

/** The store is slow, unreachable, or past its boot deadline, so nothing was read or written. */
export const STORE_RETRY_GUIDANCE =
  "The board recorded nothing. Retry the call; if it fails again, report the failure instead of assuming the change landed.";

/* One line of failure text — a stack trace is noise to a model, not detail. */
function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

/*
FNXC:StoreQueryFailureAttribution 2026-10-16-04:30:
STAS-335. The board-read failure an agent actually saw was `Failed query: select "id","name",…
from project.agents where project_id = $1 order by …` — the whole statement and nothing about why.
That shape came from a query that ERRORED after the store had already booted, so it never reached the
boot seam's typed transient error and left the tool with no table, no SQLSTATE, and no way to tell a
read outage from a write outage. Measured against the live board the same query runs in 0.168 ms over
9 heap blocks, so cost was never the story — attribution was.

Drizzle wraps driver failures in `DrizzleQueryError`, which carries `query`, `params` and the original
`cause`. This reads `query` and `cause` STRUCTURALLY and deliberately never reads `params`: the bound
values are user content (task descriptions, credentials a task stored) and must not be copied into a
tool result or an agent log. Reading `cause.code` is what recovers the SQLSTATE the message throws away.
*/
/** What a store query failure can be attributed to, without repeating it. */
export interface StoreQueryAttribution {
  readonly table?: string;
  readonly statement?: string;
  readonly sqlState?: string;
}

/*
Identifiers are matched after the quoting is removed, so one pattern covers `"project"."agents"`,
`"tasks"` and `project.agents` without quote-pairing backreferences. An earlier two-optional-group form
backtracked and returned `"s"` for `"tasks"` — a confidently wrong table name, which is exactly the
failure mode this attribution exists to remove.
*/
const QUERY_TABLE = /\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)(?:\.([a-z_][a-z0-9_]*))?/i;
const STATEMENT_KIND = /^\s*"?([a-z]+)\b/i;

/** Extract table / statement kind / SQLSTATE from a store failure. Parameter values are never read. */
export function describeStoreQueryFailure(error: unknown): StoreQueryAttribution {
  const query = (error as { query?: unknown } | null)?.query;
  if (typeof query !== "string") return {};
  const statement = STATEMENT_KIND.exec(query)?.[1]?.toLowerCase();
  const match = QUERY_TABLE.exec(query.replaceAll(`"`, ""));
  // A qualified `schema.table` names the table in group 2; a bare name is group 1.
  const table = match?.[2] ?? match?.[1];
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const sqlState = typeof cause?.code === "string" ? cause.code : undefined;
  return {
    ...(table ? { table } : {}),
    ...(statement ? { statement } : {}),
    ...(sqlState ? { sqlState } : {}),
  };
}

/** The short suffix that names the attribution, or nothing when the failure carried no query. */
function attributionNote(attribution: StoreQueryAttribution): string {
  const parts = [
    attribution.statement ? `statement=${attribution.statement}` : "",
    attribution.table ? `table=${attribution.table}` : "",
    attribution.sqlState ? `sqlState=${attribution.sqlState}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `[${parts.join(" ")}] ` : "";
}

/**
 * The store failed a call. Not-found is excluded on purpose: a card that is genuinely absent
 * is a fact about the board, and reporting it in this shape would teach agents that an
 * outage made their work disappear.
 *
 * `operation` is explicit rather than inferred, because an agent must be able to tell the two
 * classes apart from the result alone: a read that failed lost nothing, a write that failed left
 * the board unchanged.
 */
export function storeErrorResult(what: string, error: unknown, operation: "read" | "write" = "read") {
  const attribution = describeStoreQueryFailure(error);
  return {
    content: [{
      type: "text" as const,
      text: `ERROR: ${what} did not reach the task store: ${reason(error)} ${attributionNote(attribution)}${STORE_RETRY_GUIDANCE}`,
    }],
    details: {
      code: "STORE_UNAVAILABLE",
      operation,
      ...(attribution.table ? { table: attribution.table } : {}),
      ...(attribution.statement ? { statement: attribution.statement } : {}),
      ...(attribution.sqlState ? { sqlState: attribution.sqlState } : {}),
    },
    isError: true,
  };
}

/**
 * A write failure. Usually the store was unreachable — say so and name the retry. But a store call can also
 * answer with a fact about the board: the row the write targeted is absent, or the write is refused there on
 * its merits. STAS-251 keeps those cases out of the retry shape on purpose — telling an agent to retry a
 * refusal teaches them to retry it, and an outage must never look like their work disappeared.
 */
export function storeWriteFailure(what: string, error: unknown) {
  const detail = reason(error);
  if (DOMAIN_PHRASE.test(detail)) {
    return {
      content: [{ type: "text" as const, text: `ERROR: ${what} refused by the task store: ${detail}` }],
      details: { code: "STORE_REFUSAL" },
      isError: true,
    };
  }
  return storeErrorResult(what, error, "write");
}

/** How this repo's stores phrase a refusal on the merits: the row is absent, or the write is not allowed there. */
const DOMAIN_PHRASE = / (not found|does not exist|read-only)$/i;

/**
 * The store answered but kept the step on its old status — it refuses an out-of-order or
 * regressing transition by returning the task unchanged rather than throwing, so the returned
 * status is the only honest answer about what the board now holds.
 */
export function stepLifecycleNoopResult(opts: {
  stepIndex: number;
  stepName: string;
  requested: string;
  persisted: string;
  progress?: { done: number; total: number };
}) {
  const progressNote = opts.progress ? ` Progress: ${opts.progress.done}/${opts.progress.total} done.` : "";
  return {
    content: [{
      type: "text" as const,
      text: `Step ${opts.stepIndex} (${opts.stepName}) remains ${opts.persisted} — ${opts.requested} request ignored to preserve step lifecycle invariants. ${STEP_LIFECYCLE_GUIDANCE}${progressNote}`,
    }],
    details: {
      stepIndex: opts.stepIndex,
      requestedStatus: opts.requested,
      persistedStatus: opts.persisted,
      code: "STEP_LIFECYCLE_NOOP",
    },
    isError: true,
  };
}
