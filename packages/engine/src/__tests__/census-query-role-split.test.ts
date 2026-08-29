/*
FNXC:LifecycleColumnCensus 2026-08-01-04:00:

THE INVARIANT: the query class is reported split into READ-shaped (convertible) and WRITE (must not
be converted).

WHY. `column:` sits in an options-shaped object for both a source query and a write, so the existing
definition-vs-query rule cannot separate them and the single number reads as "dead reads to convert".
Measured while converting this class: outside `self-healing.ts`, the read-shaped sites are the
convertible ones and the rest are soft-delete TOMBSTONE writes plus synthetic in-memory literals.

Converting a tombstone write is **harmful**, not merely pointless: `getLiveTaskColumn` returns
"archived" as a SENTINEL for any soft-deleted row, so the write and the sentinel have to agree. That
is the same shape as #2808's `recoveryRehome` moves — a class where some members must NOT be fixed,
and a count alone cannot tell you which.

REPORTED, NOT RATCHETED. The pinned `QUERY filters` total and `queryByFile` are untouched, so the
baseline does not move. A number that misleads is worth splitting even when the pinned total must
stay byte-identical — and changing what a ratchet ENFORCES is the owner's call, not a side effect of
improving what it SAYS.
*/
import { describe, expect, it } from "vitest";

import { findComparisons, summarize } from "../../../../scripts/lib/lifecycle-column-census-ast.mjs";

const read = `export async function sweep(store) {
  const tasks = await store.listTasks({ column: "in-review", slim: true });
  return tasks;
}`;

const write = `export async function tombstone(tx, id, deletedAt) {
  await tx.update(rows).set({ column: "archived", deletedAt });
}`;

const definition = `export const ir = { nodes: [{ id: "review", kind: "review", column: "in-review" }] };`;

function roles(source: string) {
  return summarize(findComparisons("packages/x/src/probe.ts", source)).queryRoles;
}

describe("the census splits query properties by role", () => {
  it("counts a listTasks filter as READ-shaped", () => {
    expect(roles(read)).toMatchObject({ read: 1, write: 0 });
  });

  it("counts a .set() tombstone as a WRITE", () => {
    // The one that must never be converted — see the header.
    expect(roles(write)).toMatchObject({ read: 0, write: 1 });
  });

  it("still excludes IR node definitions from the query class entirely", () => {
    // A definition carries `id:`/`kind:`; converting one would be nonsense, and the pre-existing
    // rule that separates them must keep working.
    const summary = summarize(findComparisons("packages/x/src/probe.ts", definition));

    expect(summary.properties.definition).toBe(1);
    expect(summary.properties.query).toBe(0);
  });

  it("leaves the pinned query total unchanged by the split", () => {
    // The ratchet pins `properties.query` and `queryByFile`; the split must be additive.
    const summary = summarize(findComparisons("packages/x/src/probe.ts", `${read}\n${write}`));

    expect(summary.properties.query).toBe(2);
    expect(summary.queryRoles.read + summary.queryRoles.write + summary.queryRoles.other).toBe(2);
  });
});
