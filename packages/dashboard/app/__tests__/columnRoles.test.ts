/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
Coverage for the column-ROLE helpers extracted from ListView's three copy-pasted id
fallbacks.

WHAT THIS PINS THAT THE INLINE COPIES COULD NOT. The fallback branch — "no resolved
traits, guess from the id" — was unreachable from any test while it lived inline inside
two `handleMove` closures and a `useCallback`. It is also the branch that matters most: it
runs during first paint and for a stranded card, and when it is wrong the failure is
SILENT (a badge that stops appearing, a preserve-progress prompt that stops asking before
a move discards completed steps). Nothing throws.

So both directions are asserted for both helpers: traits win when present, ids are used
only when they are absent, and — the case that would otherwise rot — a resolved column
whose traits say "not pre-implementation" is NOT overridden by an id that happens to be
`todo`. That inversion is what a fourth inline copy would eventually get wrong.

REVERT CHECK, measured: making either helper ignore its flags argument (`return
LEGACY_….has(columnId)`) fails the "traits win" cases; making it ignore the id fallback
(`return Boolean(flags?.intake)`) fails the degraded cases.
*/
import { describe, expect, it } from "vitest";
import {
  isCompleteColumnRole,
  isReviewColumnRole,
  isWipColumnRole,
isFieldEditableColumnRole, isIntakeColumnRole, isPreImplementationColumnRole
} from "../utils/columnRoles";

describe("isIntakeColumnRole", () => {
  it("uses the intake TRAIT when the column resolved", () => {
    // The point of the whole conversion: a workflow-named intake column with no legacy id.
    expect(isIntakeColumnRole({ intake: true }, "backlog")).toBe(true);
  });

  it("returns false for a resolved column that is not intake, whatever its id", () => {
    /*
    The inversion. `triage` is the legacy intake id, so a helper that consulted the id
    first — or fell through to it — would answer true here and put a Planning badge on a
    column its own workflow says is mid-flight.
    */
    expect(isIntakeColumnRole({ intake: false, hold: true }, "triage")).toBe(false);
  });

  it("falls back to the legacy intake id when the column has NO resolved traits", () => {
    // First paint, or a card stranded in a column the workflow no longer declares.
    expect(isIntakeColumnRole(undefined, "triage")).toBe(true);
    expect(isIntakeColumnRole(undefined, "in-progress")).toBe(false);
  });
});

describe("isPreImplementationColumnRole", () => {
  it("treats EITHER intake or hold as pre-implementation", () => {
    // Both mean work has not started, so moving a part-done card in risks its steps.
    expect(isPreImplementationColumnRole({ intake: true }, "backlog")).toBe(true);
    expect(isPreImplementationColumnRole({ hold: true }, "parked")).toBe(true);
  });

  it("returns false for a resolved WIP column even when its id is a legacy one", () => {
    /*
    The regression this guards: `todo` is the post-U11 merged planning id, so an
    id-consulting fallback would prompt on a move into a column whose traits say
    implementation happens there — training operators to dismiss the prompt.
    */
    expect(isPreImplementationColumnRole({ intake: false, hold: false }, "todo")).toBe(false);
  });

  it("falls back to the legacy pre-implementation ids when traits are absent", () => {
    /*
    THE SILENT-LOSS CASE. Without this branch a move during first paint skips the
    preserve-progress prompt entirely and the operator loses completed steps with no
    error. It is the reason the fallback survives the conversion.
    */
    expect(isPreImplementationColumnRole(undefined, "todo")).toBe(true);
    expect(isPreImplementationColumnRole(undefined, "triage")).toBe(true);
    expect(isPreImplementationColumnRole(undefined, "in-review")).toBe(false);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-30-00:15 (U12 — one affordance, two components):
FIELD EDITABILITY. TaskDetailModal resolved this from traits in U10/R8; TaskCard kept a hardcoded
`{triage, todo}` set with no trait path, so a renamed board lost the pencil on the card while the
modal kept it — the same one-surface-missed shape as the FN-6115 chevron chain.

The VETO cases are the ones worth pinning: a column can legally carry `hold` AND a WIP or review
trait, and a plain `intake || hold` check would let an operator rewrite a description while a session
executes against it.
*/
describe("isFieldEditableColumnRole", () => {
  it("allows editing in a renamed pre-implementation column", () => {
    expect(isFieldEditableColumnRole({ intake: true }, "backlog")).toBe(true);
    expect(isFieldEditableColumnRole({ hold: true }, "parked")).toBe(true);
  });

  it("VETOES editing when a terminal, executing or review trait is also present", () => {
    expect(isFieldEditableColumnRole({ hold: true, countsTowardWip: true }, "parked")).toBe(false);
    expect(isFieldEditableColumnRole({ intake: true, mergeBlocker: true }, "backlog")).toBe(false);
    expect(isFieldEditableColumnRole({ intake: true, humanReview: true }, "backlog")).toBe(false);
    expect(isFieldEditableColumnRole({ intake: true, complete: true }, "backlog")).toBe(false);
  });

  it("refuses a resolved column with no pre-implementation trait", () => {
    expect(isFieldEditableColumnRole({ countsTowardWip: true }, "building")).toBe(false);
  });

  it("falls back to the legacy id pair when traits are absent", () => {
    // First paint, and what every caller got before the conversion.
    expect(isFieldEditableColumnRole(undefined, "todo")).toBe(true);
    expect(isFieldEditableColumnRole(undefined, "triage")).toBe(true);
    expect(isFieldEditableColumnRole(undefined, "backlog")).toBe(false);
    expect(isFieldEditableColumnRole(undefined, "in-progress")).toBe(false);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-30-19:00 (fleet phase):
Complete, review, and implementation roles use the same flags-first helper contract as intake and hold.

Each case asserts BOTH directions, because a helper that returns false unconditionally would satisfy
a one-sided test while converting every site to a dead guard.
*/
describe("terminal and mid-flight column roles", () => {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-22:40 (PR #2688 review — greptile, and it is right):
  RESOLVED METADATA WINS, asserted against a MATCHING legacy id.

  My other false cases pass a non-matching id (`isCompleteColumnRole(undefined, "shipped")`), which a
  broken `trait || legacyId` implementation satisfies just as well — no trait AND no id match, so
  false either way. They prove the fallback fires; they do not prove precedence.

  These do: the trait says false while the id says true. Flags-first returns false; an OR returns
  true. That is the only shape that separates the two implementations, and it is the one that
  matters — a resolved column whose trait is explicitly off must not be overridden by its name.
  */
  it("lets a resolved FALSE trait beat a matching legacy id", () => {
    expect(isCompleteColumnRole({ complete: false }, "done")).toBe(false);
    expect(isWipColumnRole({ countsTowardWip: false }, "in-progress")).toBe(false);
    expect(isReviewColumnRole({ mergeBlocker: false, humanReview: false }, "in-review")).toBe(false);
  });

  it("isCompleteColumnRole reads the complete trait and does not count the historical sentinel", () => {
    expect(isCompleteColumnRole({ complete: true }, "shipped")).toBe(true);
    expect(isCompleteColumnRole(undefined, "archived")).toBe(false);
    expect(isCompleteColumnRole(undefined, "done")).toBe(true);
    expect(isCompleteColumnRole(undefined, "shipped")).toBe(false);
  });

  it("isWipColumnRole keys on countsTowardWip, the same flag capacity arithmetic uses", () => {
    /*
    Keyed on `countsTowardWip` deliberately: a board must not be able to have a column that counts
    toward WIP for capacity but not for this predicate, which is what a separate `wip` trait name
    would allow.
    */
    expect(isWipColumnRole({ countsTowardWip: true }, "building")).toBe(true);
    expect(isWipColumnRole({ intake: true }, "backlog")).toBe(false);
    expect(isWipColumnRole(undefined, "in-progress")).toBe(true);
    expect(isWipColumnRole(undefined, "building")).toBe(false);
  });

  it("isReviewColumnRole accepts EITHER mergeBlocker or humanReview", () => {
    // Separable traits — a lane can block merges with no human in it, and vice versa — but every
    // converted caller asks "is this card in review", for which both qualify.
    expect(isReviewColumnRole({ mergeBlocker: true }, "signoff")).toBe(true);
    expect(isReviewColumnRole({ humanReview: true }, "signoff")).toBe(true);
    expect(isReviewColumnRole({ countsTowardWip: true }, "building")).toBe(false);
    expect(isReviewColumnRole(undefined, "in-review")).toBe(true);
    expect(isReviewColumnRole(undefined, "signoff")).toBe(false);
  });
});
