import { describe, expect, it } from "vitest";
import { resolvePostCommentRetriageDecision } from "../task-store/comments-ops.js";

/*
FNXC:PostCommentRetriage 2026-07-29-19:15:
Characterization of the decision `addCommentImpl` makes when a USER comments on a
card that is still in a pre-implementation column: either the pending spec approval
is invalidated, or an already-specified card is sent back for re-specification.
Both write `status: "needs-replan"`; they differ in the audit wording, and — the
case that matters — in WHETHER anything happens at all.

These cases pin the behaviour BEFORE the U11 column conversion, including the
default-lineage hole they expose. The conversion commit changes the last two.
*/
describe("resolvePostCommentRetriageDecision — pre-conversion behaviour", () => {
  it("invalidates a pending approval on the legacy planner column", () => {
    expect(resolvePostCommentRetriageDecision({ column: "triage", status: "awaiting-approval", hasRealPrompt: false }))
      .toEqual({ invalidateApproval: true, retriagePlanned: false });
  });

  it("re-triages a specified card on the legacy planner column", () => {
    expect(resolvePostCommentRetriageDecision({ column: "triage", status: null, hasRealPrompt: true }))
      .toEqual({ invalidateApproval: false, retriagePlanned: true });
  });

  it("re-triages a specified card in the hold column", () => {
    expect(resolvePostCommentRetriageDecision({ column: "todo", status: null, hasRealPrompt: true }))
      .toEqual({ invalidateApproval: false, retriagePlanned: true });
  });

  it("does nothing for an unspecified card with no pending approval", () => {
    expect(resolvePostCommentRetriageDecision({ column: "todo", status: null, hasRealPrompt: false }))
      .toEqual({ invalidateApproval: false, retriagePlanned: false });
  });

  /*
  The two below are the U11 hole. `builtin:coding` resolves to
  BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR, whose merged Planning column
  keeps the id `todo` and declares NO `triage` column at all — so a default card
  awaiting spec approval sits in `todo` and matches neither `triage` arm.
  */
  it("PRE-CONVERSION HOLE: a merged-column card awaiting approval is NOT invalidated", () => {
    expect(resolvePostCommentRetriageDecision({ column: "todo", status: "awaiting-approval", hasRealPrompt: false }))
      .toEqual({ invalidateApproval: false, retriagePlanned: false });
  });

  it("PRE-CONVERSION HOLE: with a real spec it is re-triaged instead of invalidated", () => {
    expect(resolvePostCommentRetriageDecision({ column: "todo", status: "awaiting-approval", hasRealPrompt: true }))
      .toEqual({ invalidateApproval: false, retriagePlanned: true });
  });
});
