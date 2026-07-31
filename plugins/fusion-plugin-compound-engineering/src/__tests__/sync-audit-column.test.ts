/*
FNXC:WorkflowLifecycleColumns 2026-07-30-16:05:

THE INVARIANT: the CE sync queue records the lane a card actually reached.

`onTaskMoved` records the real `toColumn` it is handed. `onTaskCompleted` wrote the literal `"done"`,
so on a board whose complete lane is named anything else the queue row named a column that board does
not have. Nothing READS `toColumn` — it is audit metadata, not a control signal — which is both why
it went unnoticed and why it matters: the single thing a wrong audit row costs you is the ability to
reconstruct what happened after the fact.

WHY THIS IS A STRUCTURAL RATCHET AND NOT A BEHAVIOURAL TEST, stated rather than glossed.
`getCePipelineStore` requires a live PostgreSQL `AsyncDataLayer` and throws without one, so driving
the hook means standing up PG to re-assert a one-token substitution — against the standing rule not
to add slow tests. The repo already accepts this trade in the same shape (see
`packages/core/src/__tests__/analytics-timing-roles-resolved.test.ts`, whose analytics aggregators
have the same problem).

What it therefore does and does not prove: it pins that the hook reads the card's own column and
holds no completion literal. It does not exercise the write. That is honest coverage of a metadata
field, not a substitute for one.

REVERT PROOF, measured: restore `toColumn: "done"` and both assertions fail.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the CE sync queue records the real completion lane", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

  it("onTaskCompleted enqueues the card's own column", () => {
    expect(source).toContain("toColumn: task.column,");
  });

  it("holds no hardcoded completion lane", () => {
    // Comments are stripped first: this file's own explanation names the old literal, and a ratchet
    // that matches its own prose passes forever without checking anything.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(code).not.toContain('toColumn: "done"');
  });
});
