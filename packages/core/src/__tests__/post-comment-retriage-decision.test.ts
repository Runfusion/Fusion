import { describe, expect, it } from "vitest";
import { resolvePostCommentRetriageDecision } from "../task-store/comments-ops.js";

/*
FNXC:PostCommentRetriage 2026-07-29-19:15:
Characterization of the decision `addCommentImpl` makes when a USER comments on a
card that is still in a pre-implementation column: either the pending spec approval
is invalidated, or an already-specified card is sent back for re-specification.
Both write `status: "needs-replan"`; they differ in the audit wording, and — the
case that matters — in WHETHER anything happens at all.

Post-conversion: STATUS decides. The two cases marked U11 REGRESSION GUARD are the
ones the column literals got wrong for the default lineage — they fail if the
`column === "triage"` checks come back.
*/
describe("resolvePostCommentRetriageDecision — status is the discriminator", () => {
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
  The three below are what the column literals got wrong. `builtin:coding` resolves
  to BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR, whose merged Planning column
  keeps the id `todo` and declares NO `triage` column — so a default card awaiting
  spec approval matched neither `triage` arm.
  */
  it("U11 REGRESSION GUARD: a merged-Planning card awaiting approval IS invalidated", () => {
    // Pre-conversion this returned all-false: the approval silently stood.
    expect(resolvePostCommentRetriageDecision({ column: "todo", status: "awaiting-approval", hasRealPrompt: false }))
      .toEqual({ invalidateApproval: true, retriagePlanned: false });
  });

  it("U11 REGRESSION GUARD: invalidation wins over re-triage when a spec exists", () => {
    // Pre-conversion this re-triaged, mis-auditing an approval invalidation.
    expect(resolvePostCommentRetriageDecision({ column: "todo", status: "awaiting-approval", hasRealPrompt: true }))
      .toEqual({ invalidateApproval: true, retriagePlanned: false });
  });

  it("a card on a workflow with a differently-named planning column behaves the same", () => {
    // The point of the conversion: no column id appears in the decision at all.
    expect(resolvePostCommentRetriageDecision({ column: "planning", status: "awaiting-approval", hasRealPrompt: false }))
      .toEqual({ invalidateApproval: true, retriagePlanned: false });
  });
});
