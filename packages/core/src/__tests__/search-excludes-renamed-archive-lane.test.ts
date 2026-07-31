/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
LIVE SEARCH EXCLUDED THE `archived` ID, NOT THE BOARD'S ARCHIVE LANE.

`liveSearchPredicate` builds the "not archived" half of every task search. Keyed on the literal, a
card filed away on a renamed board stayed in every live search result — including the CREATE-time
near-duplicate check, which calls `searchTasks()`. So creating a task could be rejected as a duplicate
of one the operator had already archived, with no way to see why.

THIS IS A LANE SITE, and that distinction is the whole point of the triage in
`archived-column-gate-parity.test.ts`: two of the eight Drizzle `archived` sites are STATE markers
(`cleanupArchivedTasksImpl`, `listSoftDeletedColumnDriftCandidates`) that must NEVER be resolved —
one of them deletes directories. This one asks about the board and must be.

WHY THIS DOES NOT TRIP THE PARITY GATE, which is the interesting part. That gate exists because
converting one encoding while the others compare the raw string makes them disagree. This conversion
is ADDITIVE: it adds a resolved path and keeps the literal as the documented fallback, so the SQL
encoding's literal count is unchanged and no encoding moves relative to another. A board that
supplies no resolved set gets byte-identical SQL.

That means this family can be converted INCREMENTALLY after all — one site at a time, each keeping
its fallback — rather than in the single coordinated commit the gate's message implies. The gate's
rule is about not letting the encodings DIVERGE, not about batching.

Asserted on the composed predicate rather than through a live query: the subject is which lanes the
SQL excludes, and a database fixture would test Drizzle's rendering instead.
*/

import { describe, expect, it } from "vitest";
import { liveSearchPredicate } from "../task-store/async-search.js";

/*
Drizzle SQL objects hold their bound params as nested nodes, and the graph is CYCLIC — a column
points back at its table, which points back at its columns. The first version of this walker had no
visited set and blew the stack on the first assertion. Reading the params out is still the right
approach (the alternative is asserting on rendered SQL text, which pins Drizzle's formatting rather
than which lanes are excluded), so the walker just needs to remember where it has been.
*/
function boundValues(predicate: unknown): string[] {
  const seen: string[] = [];
  const visited = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node == null || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.value === "string") seen.push(record.value);
    Object.values(record).forEach(walk);
  };
  walk(predicate);
  return seen;
}

describe("live search excludes the board's own archive lanes", () => {
  it("excludes a RENAMED archive lane when the resolved set is supplied", () => {
    const predicate = liveSearchPredicate(false, undefined, new Set(["archived", "filed"]));

    /* Against the literal, `filed` was never excluded and archived cards stayed in live search. */
    expect(boundValues(predicate)).toContain("filed");
  });

  /*
  CONTROL. The resolved set is legacy-seeded, so the built-in id must still be excluded — a
  conversion that resolved the renamed lane and dropped the legacy one would break every default
  board while passing the case above.
  */
  it("still excludes the legacy `archived` id alongside it", () => {
    const predicate = liveSearchPredicate(false, undefined, new Set(["archived", "filed"]));

    expect(boundValues(predicate)).toContain("archived");
  });

  /*
  FAIL-SOFT. The parameter is optional and `resolveProjectColumnsForRoles` can answer undefined on an
  unreadable workflow list. An unwired or degraded caller must produce exactly the SQL it produced
  before this change — that is what keeps the parity gate's encodings in step.
  */
  it("falls back to the legacy id when no resolved set is supplied", () => {
    const predicate = liveSearchPredicate(false, undefined, undefined);

    expect(boundValues(predicate)).toContain("archived");
    expect(boundValues(predicate)).not.toContain("filed");
  });

  /*
  The paired negative: `includeArchived` still wins. Resolving the lanes must not start excluding
  them from a search that deliberately asked for archived rows.
  */
  it("excludes nothing when the caller asked to include archived", () => {
    const predicate = liveSearchPredicate(true, undefined, new Set(["archived", "filed"]));

    expect(boundValues(predicate)).not.toContain("filed");
  });
});
