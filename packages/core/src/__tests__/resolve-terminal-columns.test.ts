/*
FNXC:WorkflowLifecycleColumns 2026-07-29-13:40:
Direct coverage for `resolveTerminalColumns`, the shared owner of the terminal pair.

WHY THIS EXISTS SEPARATELY from the E2E that already exercises it through
`runAiMerge`: the OTHER consumer — executor's `parkCompletedBlockedTask` guard — is a
private method reached only from inside executor dispatch, so it cannot be driven end
to end. Its correctness now rests entirely on this function, which therefore gets its
own tests rather than inheriting confidence from a caller that happens to be reachable.

THE PER-ROLE RULE IS THE POINT. A per-SET fallback collapses to one element for a
workflow that declares `complete` but no `archived`, silently dropping half of every
already-finished check — the P1 from PR #2471's review. Both partial shapes are tested
in both directions here, because a per-set implementation passes for whichever role
happens to be declared and fails for the other.
*/
import { describe, expect, it } from "vitest";
import "../index.js"; // registers the built-in column traits
import type { WorkflowIr } from "../workflow-ir-types.js";
import { resolveTerminalColumns } from "../workflow-lifecycle-traits.js";

function ir(columns: Array<{ id: string; trait: string }>): WorkflowIr {
  return {
    version: "v2",
    id: "custom:terminal-test",
    name: "terminal-test",
    columns: columns.map((c) => ({ id: c.id, name: c.id, traits: [{ trait: c.trait }] })),
    nodes: [
      { id: "start", kind: "start", column: columns[0]?.id },
      { id: "end", kind: "end", column: columns[columns.length - 1]?.id },
    ],
    edges: [{ from: "start", to: "end" }],
  } as WorkflowIr;
}

describe("resolveTerminalColumns", () => {
  it("returns both renamed roles when the workflow declares both", () => {
    expect(
      resolveTerminalColumns(ir([{ id: "shipped", trait: "complete" }, { id: "attic", trait: "archived" }])),
    ).toEqual(["shipped", "attic"]);
  });

  it("keeps the legacy `archived` when only `complete` is declared", () => {
    /* The P1 direction. A per-set fallback returns ["shipped"] here and the archived
       short circuit silently stops existing. */
    expect(resolveTerminalColumns(ir([{ id: "shipped", trait: "complete" }]))).toEqual(["shipped", "archived"]);
  });

  it("keeps the legacy `done` when only `archived` is declared", () => {
    /* The mirror direction, which is what proves the rule is per-ROLE rather than
       "whichever one we happened to find". */
    expect(resolveTerminalColumns(ir([{ id: "attic", trait: "archived" }]))).toEqual(["done", "attic"]);
  });

  it("falls back to both legacy ids for a workflow declaring neither", () => {
    expect(resolveTerminalColumns(ir([{ id: "backlog", trait: "hold" }]))).toEqual(["done", "archived"]);
  });

  it("resolves the built-in vocabulary to the legacy pair, byte-identically", () => {
    /* The regression floor: the default workflow must keep behaving exactly as the raw
       literal pair did, or this refactor changed the default board. */
    expect(
      resolveTerminalColumns(ir([{ id: "done", trait: "complete" }, { id: "archived", trait: "archived" }])),
    ).toEqual(["done", "archived"]);
  });
});
