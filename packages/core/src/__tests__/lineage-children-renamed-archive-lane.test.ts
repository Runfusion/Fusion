/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
AN ARCHIVED CHILD KEPT BLOCKING ITS PARENT'S DELETE ON A RENAMED BOARD.

`liveLineageChildFilter` is the lineage-integrity gate (VAL-DATA-010) behind `deleteTask` and
`archiveTask`: a parent with LIVE children is refused with `TaskHasLineageChildrenError`. It excluded
children in the `archived` column by id, so on a board that renames that lane an archived child still
counted as live and the parent could not be deleted — with an error naming a child the operator had
already filed away.

THE FIX IS PERMISSIVE, AND THAT IS THE CORRECT DIRECTION. The gate exists to protect live children;
an archived child is not one. Resolving makes fewer rows block, which is what the gate always meant.
Worth stating explicitly because "converting a guard makes a delete gate stop firing" deserves a
second look — the second look is that it was firing on rows it was never meant to protect.

LANE, not STATE. The triage in `archived-column-gate-parity.test.ts` splits the eight Drizzle
`archived` sites; the two STATE ones are marked at their own sites and must never be resolved (one
deletes directories). This one asks about the board.

Asserted on the composed predicate rather than through a live delete: the subject is which children
the SQL counts as live. A database fixture would exercise Drizzle and the delete path instead, and
would not distinguish this guard from the three other conditions in the same `and(...)`.
*/

import { describe, expect, it } from "vitest";
import { liveLineageChildFilter } from "../task-store/async-lifecycle.js";

/*
Drizzle's SQL graph is CYCLIC (column -> table -> columns), so this needs a visited set — the first
version of the sibling search test blew the stack without one.
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

describe("the lineage-children gate excludes the board's own archive lanes", () => {
  it("excludes a RENAMED archive lane when the resolved set is supplied", () => {
    const filter = liveLineageChildFilter("KB-PARENT", "p1", new Set(["archived", "filed"]));

    /* Against the literal, a child in `filed` still counted as live and blocked the parent. */
    expect(boundValues(filter)).toContain("filed");
  });

  /*
  CONTROL. The resolved set is legacy-seeded, so the built-in id must still be excluded — a
  conversion that resolved the renamed lane and dropped the legacy one would break every default
  board while satisfying the case above.
  */
  it("still excludes the legacy `archived` id alongside it", () => {
    const filter = liveLineageChildFilter("KB-PARENT", "p1", new Set(["archived", "filed"]));

    expect(boundValues(filter)).toContain("archived");
  });

  /*
  FAIL-SOFT, and this is what keeps the parity gate's encodings in step: an unwired caller, or one
  whose workflow list could not be read, must produce exactly the SQL it produced before.
  */
  it("falls back to the legacy id when no resolved set is supplied", () => {
    const filter = liveLineageChildFilter("KB-PARENT", "p1");

    expect(boundValues(filter)).toContain("archived");
    expect(boundValues(filter)).not.toContain("filed");
  });

  /*
  The paired negative. The other three conditions in this predicate are what make it a LINEAGE gate
  rather than a generic live filter; widening the archive exclusion must not disturb them.
  */
  it("still scopes to the parent and its project", () => {
    const values = boundValues(liveLineageChildFilter("KB-PARENT", "p1", new Set(["archived"])));

    expect(values).toContain("KB-PARENT");
    expect(values).toContain("p1");
  });
});
