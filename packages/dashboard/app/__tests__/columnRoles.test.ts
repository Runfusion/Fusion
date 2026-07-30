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
  isHoldColumnRole,
  isIntakeColumnRole,
  isPlannerLaneColumnRole,
  isPreExecutionHoldColumnRole,
  isPreImplementationColumnRole,
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
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
THE TWO ASYMMETRIC HELPERS. Both look like they should just delegate to
`isPreImplementationColumnRole`, and both deliberately do not. Left undocumented and
untested, the next reader "simplifies" them into it — so the difference is asserted here,
with the failure mode in each name.
*/
describe("isPreExecutionHoldColumnRole (narrower FALLBACK than pre-implementation)", () => {
  it("matches the pre-implementation helper once traits are resolved", () => {
    expect(isPreExecutionHoldColumnRole({ hold: true }, "parked")).toBe(true);
    expect(isPreExecutionHoldColumnRole({ intake: false, hold: false }, "todo")).toBe(false);
  });

  it("does NOT fall back to the legacy hold id, unlike the pre-implementation helper", () => {
    /*
    The asymmetry, and why: this gates the Plan ACTION rather than a prompt, and pre-U11
    `todo` was the ready-to-execute lane. Guessing generously here offers a re-plan on a
    card that is running; guessing generously in the prompt costs one confirmation.
    Measured, not assumed — widening this failed the existing TaskContextMenu suite.
    */
    expect(isPreExecutionHoldColumnRole(undefined, "todo")).toBe(false);
    expect(isPreImplementationColumnRole(undefined, "todo")).toBe(true);
    // The intake id is still enough on its own.
    expect(isPreExecutionHoldColumnRole(undefined, "triage")).toBe(true);
  });
});

describe("isPlannerLaneColumnRole (a hold lane counts only while replanning)", () => {
  it("treats an intake lane as the planner's lane regardless of replan state", () => {
    expect(isPlannerLaneColumnRole({ intake: true }, "backlog", false)).toBe(true);
  });

  it("treats a plain hold lane as the planner's lane ONLY while replanning", () => {
    /*
    A parked hold card is waiting, not being worked on. Counting it as agent-active lights
    the pulsing badge, the row border AND the column header's executing count on an idle
    card — one predicate, three surfaces.
    */
    expect(isPlannerLaneColumnRole({ hold: true }, "parked", false)).toBe(false);
    expect(isPlannerLaneColumnRole({ hold: true }, "parked", true)).toBe(true);
  });

  it("keeps the same replan condition in the no-metadata fallback", () => {
    expect(isPlannerLaneColumnRole(undefined, "triage", false)).toBe(true);
    expect(isPlannerLaneColumnRole(undefined, "todo", false)).toBe(false);
    expect(isPlannerLaneColumnRole(undefined, "todo", true)).toBe(true);
  });
});

describe("isHoldColumnRole", () => {
  it("reads the hold trait, falling back to the legacy hold id", () => {
    // The intake and hold fallbacks name DIFFERENT ids, because post-U11 `todo` carries
    // both traits while `triage` was intake only. Neither derives from the other.
    expect(isHoldColumnRole({ hold: true }, "parked")).toBe(true);
    expect(isHoldColumnRole({ hold: false }, "todo")).toBe(false);
    expect(isHoldColumnRole(undefined, "todo")).toBe(true);
    expect(isHoldColumnRole(undefined, "triage")).toBe(false);
  });
});
