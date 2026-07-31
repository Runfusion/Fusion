// @vitest-environment node
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-20:55:
EVERY in-review signal call site in reads.ts must be given the board's resolved review lanes.

THE DEFECT. `reads.ts` computes two adjacent signals for the same card: `inReviewStall` (via
`getInReviewStallReason`) and `inReviewStalled` (via `getInReviewStalledSignal`). #2951 wired the
resolved lane SET into three of the four `getInReviewStallReason` call sites and into every
`getInReviewStalledSignal` one — but at the first site the `resolveReviewColumnsForTask` await sat
BELOW the call, so that one path silently kept the legacy single-lane fallback.

On a board declaring a separate merge lane beside its human-review lane, `inReviewStall` then read
the first review column only while `inReviewStalled` two lines down read both: the same card is
"in review" for one signal and not the other. Two signals disagreeing is worse than both being
legacy, and it is invisible on every builtin board because there the review set has one element.

WHY A SOURCE RATCHET RATHER THAN A BEHAVIOURAL TEST. The existing
`unwired-lane-parameter-guard` does NOT cover this: it asks whether any file NAMES the declaring
interface, so it is satisfied by the import alone. Measured — removing the `reviewColumns:` line
from the fixed call site leaves that guard at 9/9 green. The call sites live inside a store read
path behind PostgreSQL fixtures, so pinning the wiring at the source is the honest coverage until
someone stands that path up end to end.

Counts, not line numbers: line numbers churn on unrelated edits and a ratchet that cries wolf gets
deleted.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../task-store/reads.ts", import.meta.url), "utf8");

/** Option-object literals passed to `fn(task, { … })`, one entry per call site. */
function optionLiterals(fn: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(`${fn}(task, {`, from);
    if (start < 0) break;
    let depth = 0;
    let i = source.indexOf("{", start);
    const open = i;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(open, i + 1));
    from = i;
  }
  return out;
}

describe("in-review signals receive the board's resolved review lanes", () => {
  for (const fn of ["getInReviewStallReason", "getInReviewStalledSignal", "getStalePausedReviewSignal"]) {
    it(`every ${fn} call site in reads.ts passes reviewColumns`, () => {
      const calls = optionLiterals(fn);

      /* A parse that found nothing would make the assertion below vacuous — the failure mode this
         whole guard family keeps producing. */
      expect(calls.length, `no ${fn}(task, { … }) call sites found in reads.ts`).toBeGreaterThan(0);

      const missing = calls.filter((literal) => !literal.includes("reviewColumns:"));
      expect(
        missing.length,
        `${missing.length} of ${calls.length} ${fn} call sites omit reviewColumns, so they keep the `
        + `legacy single-lane fallback while their siblings resolve the set`,
      ).toBe(0);
    });
  }
});
