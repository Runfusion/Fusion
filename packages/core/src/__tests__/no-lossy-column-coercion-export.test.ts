/*
FNXC:WorkflowColumns 2026-07-29-00:00 (U12 — R8):
Ratchet: `@fusion/core` must not export a column coercion that discards
workflow-defined ids.

`normalizeColumn` did exactly that — it answered "is this one of the SIX legacy ids"
and rewrote everything else to `triage`, so any project with a custom column silently
lost it. It sat one line away from `normalizeColumnId`, which sanitises structurally
and passes real ids through, and the dashboard picked the wrong one for its whole task
ingest path until that was diagnosed (see `routes-trait-rekey.test.ts`).

U12 deleted it once it had zero callers. This test is what stops it — or an equivalent
under a new name — coming back: an exported helper that maps a valid custom column id
to a legacy one is the defect, regardless of what it is called.
*/
import { describe, expect, it } from "vitest";
import * as core from "../index.js";
import { normalizeColumnId } from "../types/board.js";

describe("no lossy column coercion on the core public surface", () => {
  it("does not export the deleted normalizeColumn", () => {
    expect(Object.keys(core)).not.toContain("normalizeColumn");
  });

  it("keeps normalizeColumnId non-lossy for workflow-defined ids", () => {
    // The property that made normalizeColumn wrong: a real custom column id must
    // survive. If this ever fails, the safe helper has acquired the lossy behaviour.
    for (const customId of ["ideas", "merging", "custom-hold", "signoff"]) {
      expect(normalizeColumnId(customId)).toBe(customId);
    }
    // Structural sanitisation is still expected.
    expect(normalizeColumnId("")).toBe("triage");
    expect(normalizeColumnId(undefined)).toBe("triage");
    expect(normalizeColumnId(null, "todo")).toBe("todo");
  });

  it("exports no OTHER helper that maps a custom column id onto a legacy one", () => {
    /*
    Name-agnostic: exercise every exported single-argument function whose name mentions
    "column" and fail if it turns a valid custom id into a different, legacy id. That is
    the behaviour being banned, not the identifier.
    */
    const legacy = new Set(["triage", "todo", "in-progress", "in-review", "done", "archived"]);
    const offenders: string[] = [];
    for (const [name, value] of Object.entries(core)) {
      if (typeof value !== "function" || !/column/i.test(name)) continue;
      if (value.length !== 1) continue;
      let result: unknown;
      try {
        result = (value as (input: unknown) => unknown)("custom-hold");
      } catch {
        continue; // throwing on an unknown column is fine — it is not silent loss
      }
      if (typeof result === "string" && result !== "custom-hold" && legacy.has(result)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
