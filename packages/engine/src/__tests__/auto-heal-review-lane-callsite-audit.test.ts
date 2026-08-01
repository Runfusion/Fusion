/*
FNXC:WorkflowLifecycleColumns 2026-07-31-08:45 (call-site audit — a DELIBERATE-LITERAL note that is not true):

Fourth instance of the optional-role-parameter class (#2795, #2798, #2799), and the only one so far
where the source ANNOTATION asserts the opposite of the fact.

`project-engine.ts`'s `hasAutoHealableVerificationBufferFailure` takes the review-lane answer as an
optional parameter defaulting to `task.column === "in-review"`, and its own note says:

    "Both call sites pass the resolved answer; the default exists so an unconverted caller keeps
     exactly today's behaviour rather than silently changing meaning."

There are THREE call sites, not two:

    canMergeTask:2657        threads its own `isReviewColumn` through          CONVERTED
      <- canMergeTask:2903   passes `t.column === reviewLane`                  CONVERTED
      <- canMergeTask:3334   passes `task.column === mergeLoopReviewLane`      CONVERTED
    merge loop:3655          calls it DIRECTLY with no review-lane answer      unconverted

So the note counts the two gating callers and misses the healing one. On a renamed board the auto-heal
branch inside the merge loop keys on `in-review`, does not match, and — in the words of the same
comment — "a task whose merge verification died on a buffer-overflow error was never auto-healed; it
sat retry-exhausted until a human reset it. The failure is invisible because 'no auto-heal' looks
identical to 'nothing to heal'."

Note which half is converted: the sites deciding whether a card MAY merge resolve the lane; the site
that would RECOVER a stuck card does not.

WHY THIS FILE IS A SOURCE AUDIT AND NOT AN E2E. The predicate and its caller are both PRIVATE methods
of `ProjectEngine`, so there is no seam to drive them through without standing up the merge loop. The
three sibling files in this series each carry a behavioural differential because their predicates are
exported; this one cannot, and inventing a mock ProjectEngine to assert a private method would prove
only that the mock behaves as written. Stated plainly rather than substituted for — the finding is a
call-site fact, and a call-site fact is what is asserted.

It is an alarm in both directions: a new unconverted caller fails it, and converting site 3655 fails
it too, which is the moment to delete this file and record the fix.

SYNTAX, NOT TEXT. The call sites are found by parsing `project-engine.ts` and inspecting real call
expressions, matching the repo's existing precedent for the same problem
(`core/.../sync-workflow-ir-callsite-allowlist.test.ts`). An audit that reasons about the text
following a name can be broken — or silently misled — by a formatting-only change, which is the
failure mode this whole series is about. The one prose assertion below is unavoidably textual and is
whitespace-normalised for that reason.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const FILE = join(__dirname, "..", "project-engine.ts");
const SOURCE = readFileSync(FILE, "utf8");
const PREDICATE = "hasAutoHealableVerificationBufferFailure";

/** Every call of the predicate, as its argument-expression list. A declaration is not a call
 *  expression, so it is excluded structurally rather than by guessing at its text. */
function callSites(): ts.NodeArray<ts.Expression>[] {
  const sf = ts.createSourceFile(FILE, SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: ts.NodeArray<ts.Expression>[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee) ? callee.text : undefined;
      if (name === PREDICATE) found.push(node.arguments);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

describe("auto-heal review-lane call sites", () => {
  it("finds every call site, so the audit cannot pass vacuously", () => {
    /* A renamed predicate or a moved file would otherwise leave this suite green while measuring
       nothing — the failure mode this whole series is about. */
    expect(callSites().length).toBeGreaterThan(0);
  });

  it("has exactly one call site that does NOT pass the resolved review lane", () => {
    /*
    ARITY is the property asserted, deliberately. A first version of this file filtered on whether the
    argument TEXT mentioned `isReviewColumn` / `ReviewLane`; converting the unconverted site to pass a
    plain `true` then left the count at one and the suite stayed green, so the "alarm in both
    directions" claimed above did not exist. Argument count cannot be spelled around, and parsing
    means a reflowed call cannot be miscounted either.
    */
    const unconverted = callSites().filter((args) => args.length < 3);

    expect(unconverted).toHaveLength(1);
  });

  it("the DELIBERATE-LITERAL note still claims both call sites are converted", () => {
    /*
    Pinned deliberately. The note is the artefact that would stop a reviewer looking further, so the
    audit fails when the note is corrected — forcing whoever corrects it to also decide what to do
    about the third site, rather than fixing the sentence and leaving the gap.

    Whitespace-normalised because the source wraps this sentence mid-phrase; a comment is prose and
    has no syntax to parse, so this one assertion is textual by necessity rather than by choice.
    */
    expect(SOURCE.replace(/\s+/g, " ")).toContain("Both call sites pass the resolved answer");
  });
});
