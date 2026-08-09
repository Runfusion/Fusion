# Agent activity API contract

`GET /api/agent-activity` is the project-scoped, durable activity-history API. This document is the canonical wire and cursor contract for consumers such as the agent-activity UI. Before depending on it, run [`scripts/check-fn-8864-ancestry.sh`](../scripts/check-fn-8864-ancestry.sh): it fails closed unless the FN-8864 implementation is on the current base.

## Wire shape

The response is exactly:

```ts
{ events: AgentActivityEvent[]; nextCursor: string | null }
```

Each event has these 12 fields, in the shape exported as `AgentActivityEvent`:

| Field | Wire value |
| --- | --- |
| `seq` | Decimal string representation of a PostgreSQL `bigint`. |
| `eventId` | Deterministic event identifier. |
| `projectId` | Owning project identifier. |
| `agentId` | Attributed agent, lane, or actor identifier. |
| `agentAttribution` | `"agent"`, `"lane"`, or `"actor"`; only `agent` is roster-proven. |
| `taskId` | Task identifier or `null`. |
| `type` | One of the exported agent-activity event types. |
| `fromAgentId` | Roster-proven source agent identifier or `null`. |
| `toAgentId` | Roster-proven destination agent identifier or `null`. |
| `summary` | Generated event summary. |
| `occurredAt` | ISO timestamp string. |
| `metadata` | Sanitized metadata object or `null`. |

## Bounds and ordering

`before` is an **exclusive** upper bound and `since` is an **exclusive** lower bound. Supplying both selects the **open interval `(since, before)`**. It is not a half-open interval: neither endpoint is returned.

The helper uses literal `ORDER BY seq DESC` by default and `ORDER BY seq ASC` only for its in-process ascending mode. `(project_id, seq)` is the primary key, so `seq` is unique inside a project. The ordering is therefore total; no secondary tiebreak column exists or is needed.

## Filters and limits

All filters are AND-composed and always additionally scoped to the current project. The filter names are `limit`, `before`, `since`, `agentId`, `taskId`, and `type`.

The helper defaults absent or non-finite `limit` to 100 and clamps finite values to `min(max(0, trunc(limit)), 1000)`. The HTTP route also defaults to 100, permits `limit=0` (an empty page with a null cursor), and has a hard maximum of 1000. HTTP cursors and limits must be decimal strings; invalid cursors and unknown `type` values receive 400. `order` is not an HTTP query parameter and is never forwarded, so HTTP responses are always newest-first.

## Cursor and continuation

The helper reads `limit + 1` rows to determine `hasMore`, then returns at most `limit` events. For a descending page, `nextCursor` is the last (lowest-seq) returned event only when another row exists behind it. It is `null` for an empty page or an exactly-full final page, preventing a dead cursor.

### Descending scroll-back (HTTP)

Start without `before`; for each later request send the preceding response's `nextCursor` verbatim as `before`; stop at `nextCursor === null`. The exclusive upper bound means the boundary event is never repeated. Higher-seq events appended during this walk are outside the range being walked, so they are neither duplicates nor gaps in that range; fetch them separately with a `since` tail.

### Ascending tail (in-process and SSE)

Supply `since=<highest seq already consumed>` and helper-only `order: "asc"`. Ascending mode always returns `nextCursor: null`; the caller owns continuation. SSE advances `lastDeliveredSeq` after each delivered event and keeps paging while it receives a full page. If a frame fails, the mark is unchanged, so delivery is at-least-once: a redelivery is possible, but an event is not intentionally lost.

### SSE truncation repair

A truncation frame is `{ truncated: true, fromSeq, toSeq }`. Its omitted rows are exactly the half-open range `(fromSeq, toSeq]`, which is intentionally distinct from the helper's open query interval. Repair it by paging descending through:

```text
GET /api/agent-activity?since=<fromSeq>&before=<toSeq + 1>
```

Continue with `before=nextCursor` until `nextCursor` is null.

## Append-only and retention

Rows are inserted, not updated. `eventId` is deterministic from project, type, agent, task, and discriminator, and `(project_id, event_id)` is unique. The per-project counter is locked before the duplicate probe; a deduplicated retry returns `null` without consuming a `seq`. Thus committed sequence positions are unique and commit-ordered without gaps for rows that never existed.

Retention removes rows older than 30 days, then retains at most the newest 50,000 rows per project by descending `seq`. Long-lived scroll-back cursors can therefore encounter rows pruned below their boundary; treat a missing older sequence as retention, not a pagination bug. Concurrent append is not a loss case. The other loss boundary is an SSE truncation marker, repaired as described above.

## Lossless cursor mode

Descending `before` scroll-back is lossless over the range it walks: unique commit-ordered seqs, exclusive boundaries, and no burned seq for deduplicated retries prevent duplicates and skips. Ascending `since` tailing is lossless-forward with at-least-once delivery. Retention pruning and an explicit SSE truncation marker are the two documented cases that require the caller to reconcile rather than assuming retained history is complete.

## Claim-to-proof coverage

| Claim | Bucket | Proof |
| --- | --- | --- |
| Exact event field set, decimal `seq`, and envelope keys | NEW | `agent-activity-cursor-contract.pg.test.ts` — wire/envelope case |
| Open exclusive bounds; ordering; cursor edges; ascending null cursor; lossless walk; attribution nulling; age retention | NEW | `agent-activity-cursor-contract.pg.test.ts` |
| `limit=0` route acceptance | NEW | `agent-activity-route.test.ts` — accepts zero limit |
| SSE truncation repair endpoints | NEW | `sse-agent-activity.test.ts` — bounded truncation marker |
| Route default/clamp, composable filters, and no HTTP `order` | EXISTING | `agent-activity-route.test.ts` — “defaults and clamps limits while forwarding composable filters” |
| Route invalid input and unchanged response | EXISTING | `agent-activity-route.test.ts` — “rejects invalid limits, cursors, and event types”; “returns the core newest-first page shape unchanged” |
| Default non-finite helper limit, dedupe/no burned seq, filters, no timestamp tie-break, and project isolation | EXISTING | `agent-activity-events.pg.test.ts` named cases |
| SSE ascending drain, retry, and bounded truncation behavior | EXISTING | `sse-agent-activity.test.ts` named cases |
| 30-day retention and 50,000 row cap values | CONSTANT-ONLY | `agent-activity-cursor-contract.pg.test.ts`; large row-cap seed would violate the no-slow-tests rule |

## Non-contractual internals

These implementation details are deliberately not API guarantees.

- The SSE backlog limit, page size, and maximum pages per drain are module-local constants. Their literal values are not exported, so callers must depend on the tested truncation and ascending-delivery behaviors instead.
- Pruning is currently invoked through `TaskStore.pruneAgentActivityEventsAsync()` from engine self-healing rather than a read path. This call-site ownership is not a wire behavior and is not test-pinned.
- The read mapper defensively converts array/non-object `metadata` to `null`. Sanitized writes cannot produce that state, so exercising it requires artificial SQL and is not contract-pinned.
