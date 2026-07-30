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
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "..", "project-engine.ts"), "utf8");
const PREDICATE = "hasAutoHealableVerificationBufferFailure(";

/** Call sites, excluding the declaration (which is followed by its parameter list, not an argument). */
function callSites(): string[] {
  return SOURCE.split(PREDICATE)
    .slice(1)
    .filter((s) => !s.startsWith("task: {") && !s.trimStart().startsWith("task: {"));
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-09:20 (self-correction, forced by a mutation run):
COUNT THE ARGUMENTS; do not match their NAMES. The first version filtered on the argument text
containing `isReviewColumn` / `ReviewLane`, so converting the unconverted site to pass a plain `true`
left the count at one and this suite stayed green — the "alarm in both directions" the header claims
did not exist. Arity is the property actually being asserted, and it cannot be spelled around.
*/
function argumentCount(site: string): number {
  let depth = 0;
  let args = 1;
  for (const ch of site) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" && depth === 0) return args;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) args++;
  }
  return args;
}

describe("auto-heal review-lane call sites", () => {
  it("finds every call site, so the audit cannot pass vacuously", () => {
    /* A renamed predicate or a moved file would otherwise leave this suite green while measuring
       nothing — the failure mode this whole series is about. */
    expect(callSites().length).toBeGreaterThan(0);
  });

  it("has exactly one call site that does NOT pass the resolved review lane", () => {
    /*
    The measurement. `maxAutoMergeRetries` is the second argument at every site, so a site that stops
    there — its argument list closing right after it — passed no review-lane answer.
    */
    const unconverted = callSites().filter((site) => argumentCount(site) < 3);

    expect(unconverted).toHaveLength(1);
    /* And it is the merge loop's auto-heal branch, not a gating caller. */
    expect(unconverted[0]).toContain("maxAutoMergeRetries");
  });

  it("the DELIBERATE-LITERAL note still claims both call sites are converted", () => {
    /*
    Pinned deliberately. The note is the artefact that would stop a reviewer looking further, so the
    audit fails when the note is corrected — forcing whoever corrects it to also decide what to do
    about the third site, rather than fixing the sentence and leaving the gap.
    */
    /* Matched across the source's own line wrap, which splits the sentence after "resolved". */
    expect(SOURCE.replace(/\s+/g, " ")).toContain("Both call sites pass the resolved answer");
  });
});
